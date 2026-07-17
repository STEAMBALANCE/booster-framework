// Plugin-bootstrap drain: the wiring that turns a populated PluginRegistry
// plus the C++-injected manifest prefix into actually-running plugins.
//
// Lives in its own module (extracted from index.ts) so it's unit-testable
// without paying the IIFE side-effect cost — index.ts calls
// drainPluginsOnReady() once, after lifecycle.ready resolves; tests call it
// directly with synthetic SbApi + manifest fixtures.

import {
  Capability,
  ContextKind,
  SUPPORTED_API_VERSIONS,
  type PluginManifest,
  type PluginContext,
  type SbApi,
} from '../api/api-types';
import type { Bridge } from '../bridge';
import { createTokenBridge } from '../bridge';
import { runPluginInits, type PluginInitOutcome } from './lifecycle';
import { crossValidate, type ManifestPluginEntry } from './validation';
import { buildGatedSb } from './capability-gating';
import { createPluginScope } from './scope';
import { createPluginConfigs } from './configs';
import { createPluginBus } from './bus';
import { createPluginUi } from './ui';
import { makeNetApi } from '../api/net';
import { createPluginLog } from './log';
import type { PluginRegistry } from './registry';

/** Shape of the C++-injected global prefix. */
export interface PluginsManifestPrefix {
  injectorVersion: string;
  contextKind: string;
  userDisabledPlugins: string[];
  plugins: ManifestPluginEntry[];
}

/**
 * Where outcomes of `runPluginInits` are stashed on the live SbApi so a
 * later `lifecycle.rollbackAll()` can call `runPluginCleanups`.
 */
export interface SbApiWithOutcomes extends SbApi {
  _pluginOutcomes?: PluginInitOutcome[];
}

/** Sink for diagnostics that come out of the drain (skips, validation
 *  failures). Tests inject a recording sink; production uses console. */
export interface DrainLog {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
}

const defaultDrainLog: DrainLog = {
  warn: (msg, meta) => { console.warn(`[booster-framework] ${msg}`, meta ?? ''); },
  info: (msg, meta) => { console.info(`[booster-framework] ${msg}`, meta ?? ''); },
};

export interface DrainPluginsArgs {
  registry: PluginRegistry;
  manifest: PluginsManifestPrefix | undefined;
  realSb: SbApi;
  bridge: Bridge;
  /** Live URL used for urlPatterns filtering. Injected so tests don't
   *  have to monkey-patch `location`. */
  currentUrl: string;
  /** Optional diagnostics sink (default: console). */
  log?: DrainLog;
}

/**
 * Filter registry entries by manifest match, contextKind, apiVersion,
 * urlPatterns, and cross-validate against the signed manifest entry.
 * Pure: exported so tests can assert eligibility logic without touching
 * runPluginInits.
 */
export function filterEligiblePlugins(args: {
  registry: PluginRegistry;
  manifest: PluginsManifestPrefix;
  currentUrl: string;
  log?: DrainLog;
}): {
  bundle: PluginManifest;
  manifestEntry: ManifestPluginEntry;
  authoritativeId: string;
  token?: string;
}[] {
  const { registry, manifest, currentUrl } = args;
  const log = args.log ?? defaultDrainLog;
  const currentKind = manifest.contextKind as ContextKind;
  const userDisabled = new Set(manifest.userDisabledPlugins);
  const eligible: {
    bundle: PluginManifest;
    manifestEntry: ManifestPluginEntry;
    authoritativeId: string;
    token?: string;
  }[] = [];

  for (const entry of registry.listEntries()) {
    const { manifest: bundle, authoritativeId, token } = entry;
    const manifestEntry = manifest.plugins.find((p) => p.id === authoritativeId);
    if (!manifestEntry) {
      log.warn(`plugin '${authoritativeId}' registered but not in manifest — skipping`);
      continue;
    }
    // userDisabledPlugins is a hard skip — manifest's `required` flag in
    // the spec means "cannot be user-disabled"; we honour that by only
    // skipping when NOT required.
    if (userDisabled.has(authoritativeId) && !manifestEntry.required) {
      log.info(`plugin '${authoritativeId}' user-disabled — skipping`);
      continue;
    }
    if (!bundle.contextKinds.includes(currentKind)) continue;
    if (!SUPPORTED_API_VERSIONS.has(bundle.apiVersion)) {
      log.warn(`plugin '${authoritativeId}' apiVersion ${bundle.apiVersion} not supported`);
      continue;
    }
    const v = crossValidate(bundle, manifestEntry);
    if (!v.ok) {
      log.warn(`plugin '${authoritativeId}' cross-validation failed: ${v.reason}`);
      continue;
    }
    // urlPatterns only meaningfully gate URL-bearing contexts (Web / tabbed
    // browser). In Main / Shared the "URL" is the client shell
    // (about:blank?createflags=274…), which no store pattern matches — so a
    // ['web','main'] plugin (e.g. addfunds' Main install for the store-menu
    // item) would be wrongly filtered out of Main. Skip the gate there; the
    // contextKind check above already scoped the plugin to Main.
    const urlBearingKind =
      currentKind === ContextKind.Web || currentKind === ContextKind.TabbedBrowser;
    if (urlBearingKind && bundle.urlPatterns && bundle.urlPatterns.length > 0) {
      // Bundle's urlPatterns were already cross-validated as a subset of
      // manifest's, so we can match against bundle's patterns directly.
      let matched = false;
      for (const p of bundle.urlPatterns) {
        try {
          if (new RegExp(p).test(currentUrl)) { matched = true; break; }
        } catch {
          // Invalid regex source — treat as non-match; manifest verifier
          // should have rejected this upstream, but defend in depth.
          log.warn(`plugin '${authoritativeId}' urlPattern '${p}' is not a valid regex`);
        }
      }
      if (!matched) continue;
    }
    eligible.push({ bundle, manifestEntry, authoritativeId, token });
  }
  return eligible;
}

/**
 * Drain the registry: filter, build PluginContext per plugin (cap-gated sb,
 * scope, configs, bus, ui, log), run inits, stash outcomes.
 *
 * Idempotent against missing manifest: logs a diagnostic and resolves with
 * an empty outcomes array. The manifest prefix is normally provided by the
 * native injector (`__SB_PLUGINS_MANIFEST__`, read via `readPluginsManifest`).
 */
/**
 * Soft wait for late-registering plugins.
 *
 * The framework schedules drainPluginsOnReady on a `lifecycle.ready()`
 * microtask inside its own IIFE. Plugin bundles are evaluated by the C++
 * injector in separate Runtime.evaluate calls AFTER the framework IIFE
 * returns — each call is a fresh V8 task, so microtasks drain between
 * them. Without a wait step, drain fires before any plugin's
 * sb.plugins.register has run and produces zero outcomes (silent failure:
 * no buttons / no init hooks). Polling at 10 ms with a 2 s ceiling closes
 * the race while staying invisible to fast happy paths (registry catches
 * up within the first poll on a healthy local CDP).
 */
const PLUGIN_REGISTER_WAIT_MAX_MS = 2000;
const PLUGIN_REGISTER_POLL_MS = 10;
async function waitForExpectedRegistrations(
  registry: PluginRegistry,
  expectedIds: Set<string>,
): Promise<void> {
  if (expectedIds.size === 0) return;
  const deadline = Date.now() + PLUGIN_REGISTER_WAIT_MAX_MS;
  for (;;) {
    // Use authoritativeId so injector-assigned ids are matched correctly.
    const have = new Set(registry.listEntries().map((e) => e.authoritativeId));
    let missing = 0;
    for (const id of expectedIds) if (!have.has(id)) missing++;
    if (missing === 0) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, PLUGIN_REGISTER_POLL_MS));
  }
}

export async function drainPluginsOnReady(args: DrainPluginsArgs): Promise<PluginInitOutcome[]> {
  const log = args.log ?? defaultDrainLog;
  const { registry, manifest, realSb, bridge, currentUrl } = args;

  if (!manifest) {
    log.warn('__SB_PLUGINS_MANIFEST__ missing — plugins disabled this session');
    (realSb as SbApiWithOutcomes)._pluginOutcomes = [];
    return [];
  }

  // Wait for the bundles named in the manifest (filtered to ones expected
  // to run in this contextKind) to call sb.plugins.register. Closes the
  // microtask-vs-separate-Runtime.evaluate race. Subtract user-disabled
  // non-required plugins so a disabled bundle (which C++ never injects)
  // doesn't extend the wait to the full safety-timeout; mirrors the
  // required-carve-out filterEligiblePlugins applies downstream.
  const currentKindEarly = manifest.contextKind as ContextKind;
  const userDisabled = new Set(manifest.userDisabledPlugins);
  const expectedIds = new Set(
    manifest.plugins
      .filter((p) => (p.contextKinds as readonly string[]).includes(currentKindEarly))
      .filter((p) => !userDisabled.has(p.id) || p.required)
      .map((p) => p.id),
  );
  await waitForExpectedRegistrations(registry, expectedIds);

  const eligible = filterEligiblePlugins({ registry, manifest, currentUrl, log });
  const eligibleBundles = eligible.map((e) => e.bundle);
  const currentKind = manifest.contextKind as ContextKind;

  const outcomes = await runPluginInits(eligibleBundles, (bundle): PluginContext => {
    const eligibleEntry = eligible.find((e) => e.bundle === bundle)!;
    const { manifestEntry, authoritativeId, token } = eligibleEntry;

    // Effective capabilities = (plugin requested) ∩ (manifest granted).
    const granted = new Set<Capability>(
      bundle.capabilities.filter((c) =>
        manifestEntry.grantedCapabilities.includes(c as string),
      ),
    );
    const pluginScope = createPluginScope(realSb.scope.signal, authoritativeId);

    // Per-plugin token bridge: carries the injector-assigned token on every
    // native IPC envelope, enabling the native router (A5/A6) to resolve
    // the calling plugin's identity without trusting self-declared pluginId.
    const tb: Bridge = token
      ? createTokenBridge(bridge, token, authoritativeId)
      : bridge;

    if (!token) {
      log.warn(`plugin '${authoritativeId}' has no boot token — native enforcement will deny after A6`);
    }

    // Token-bound per-plugin ConfigsApi. Both PluginContext.configs AND
    // finalSb.configs use this same object so every config call carries
    // the token regardless of access path (ctx.configs vs ctx.sb.configs).
    const pluginConfigs = granted.has(Capability.Configs)
      ? createPluginConfigs(tb, authoritativeId)
      : (undefined as never);

    // buildGatedSb gives us the standard gated view; we then swap bus + ui
    // for their per-plugin wrappers (topic-prefix-enforced bus, id-auto-
    // prefixed ui) so plugins can't fire bus events outside their namespace
    // or collide DOM ids with other plugins. Also override configs to the
    // token-bound version so ctx.sb.configs carries the token (A4 fix).
    const gated = buildGatedSb(realSb, granted);
    const finalSb: SbApi = {
      ...gated,
      bus: granted.has(Capability.Bus)
        ? createPluginBus(realSb.bus, authoritativeId, pluginScope.signal, manifestEntry.subscribeTopics ?? [])
        : (undefined as never),
      ui: granted.has(Capability.Ui)
        ? createPluginUi(realSb.ui, authoritativeId)
        : (undefined as never),
      configs: pluginConfigs,
      net: granted.has(Capability.Net) ? makeNetApi(tb) : (undefined as never),
    };

    return {
      pluginId: authoritativeId,
      contextKind: currentKind,
      apiVersion: bundle.apiVersion,
      granted,
      sb: finalSb,
      scope: pluginScope,
      configs: pluginConfigs,
      log: createPluginLog(authoritativeId, (op, pid, args2) => tb.notify(op, pid, args2 as object)),
      signal: pluginScope.signal,
    };
  });

  (realSb as SbApiWithOutcomes)._pluginOutcomes = outcomes;
  return outcomes;
}

/** Read the C++-injected manifest prefix. Returns undefined if missing or
 *  not the expected shape (defensive). */
export function readPluginsManifest(): PluginsManifestPrefix | undefined {
  const cfg = (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__;
  if (!cfg || typeof cfg !== 'object') return undefined;
  const obj = cfg as Record<string, unknown>;
  if (typeof obj.injectorVersion !== 'string') return undefined;
  if (typeof obj.contextKind !== 'string') return undefined;
  if (!Array.isArray(obj.userDisabledPlugins)) return undefined;
  if (!Array.isArray(obj.plugins)) return undefined;
  return cfg as PluginsManifestPrefix;
}
