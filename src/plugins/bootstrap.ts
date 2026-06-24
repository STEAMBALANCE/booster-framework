// Plugin-bootstrap drain: the wiring that turns a populated PluginRegistry
// plus the C++-injected manifest prefix into actually-running plugins.
//
// Lives in its own module (extracted from index.ts) so it's unit-testable
// without paying the IIFE side-effect cost — index.ts calls
// drainPluginsOnReady() once, after lifecycle.ready resolves; tests call it
// directly with synthetic SbApi + manifest fixtures.

import {
  Capability,
  SUPPORTED_API_VERSIONS,
  type ContextKind,
  type PluginManifest,
  type PluginContext,
  type SbApi,
} from '../api/api-types';
import type { Bridge } from '../bridge';
import { runPluginInits, type PluginInitOutcome } from './lifecycle';
import { crossValidate, type ManifestPluginEntry } from './validation';
import { buildGatedSb } from './capability-gating';
import { createPluginScope } from './scope';
import { createPluginConfigs } from './configs';
import { createPluginBus } from './bus';
import { createPluginUi } from './ui';
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
}[] {
  const { registry, manifest, currentUrl } = args;
  const log = args.log ?? defaultDrainLog;
  const currentKind = manifest.contextKind as ContextKind;
  const userDisabled = new Set(manifest.userDisabledPlugins);
  const eligible: { bundle: PluginManifest; manifestEntry: ManifestPluginEntry }[] = [];

  for (const bundle of registry.list()) {
    const manifestEntry = manifest.plugins.find((p) => p.id === bundle.id);
    if (!manifestEntry) {
      log.warn(`plugin '${bundle.id}' registered but not in manifest — skipping`);
      continue;
    }
    // userDisabledPlugins is a hard skip — manifest's `required` flag in
    // the spec means "cannot be user-disabled"; we honour that by only
    // skipping when NOT required.
    if (userDisabled.has(bundle.id) && !manifestEntry.required) {
      log.info(`plugin '${bundle.id}' user-disabled — skipping`);
      continue;
    }
    if (!bundle.contextKinds.includes(currentKind)) continue;
    if (!SUPPORTED_API_VERSIONS.has(bundle.apiVersion)) {
      log.warn(`plugin '${bundle.id}' apiVersion ${bundle.apiVersion} not supported`);
      continue;
    }
    const v = crossValidate(bundle, manifestEntry);
    if (!v.ok) {
      log.warn(`plugin '${bundle.id}' cross-validation failed: ${v.reason}`);
      continue;
    }
    if (bundle.urlPatterns && bundle.urlPatterns.length > 0) {
      // Bundle's urlPatterns were already cross-validated as a subset of
      // manifest's, so we can match against bundle's patterns directly.
      let matched = false;
      for (const p of bundle.urlPatterns) {
        try {
          if (new RegExp(p).test(currentUrl)) { matched = true; break; }
        } catch {
          // Invalid regex source — treat as non-match; manifest verifier
          // should have rejected this upstream, but defend in depth.
          log.warn(`plugin '${bundle.id}' urlPattern '${p}' is not a valid regex`);
        }
      }
      if (!matched) continue;
    }
    eligible.push({ bundle, manifestEntry });
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
 * no buttons / no init hooks). Polling at 10 ms with a 1 s ceiling closes
 * the race while staying invisible to fast happy paths (registry catches
 * up within the first poll on a healthy local CDP).
 */
const PLUGIN_REGISTER_WAIT_MAX_MS = 1000;
const PLUGIN_REGISTER_POLL_MS = 10;
async function waitForExpectedRegistrations(
  registry: PluginRegistry,
  expectedIds: Set<string>,
): Promise<void> {
  if (expectedIds.size === 0) return;
  const deadline = Date.now() + PLUGIN_REGISTER_WAIT_MAX_MS;
  for (;;) {
    const have = new Set(registry.list().map((b) => b.id));
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
    const manifestEntry = eligible.find((e) => e.bundle.id === bundle.id)!.manifestEntry;
    // Effective capabilities = (plugin requested) ∩ (manifest granted).
    const granted = new Set<Capability>(
      bundle.capabilities.filter((c) =>
        manifestEntry.grantedCapabilities.includes(c as string),
      ),
    );
    const pluginScope = createPluginScope(realSb.scope.signal, bundle.id);

    // buildGatedSb gives us the standard gated view; we then swap bus + ui
    // for their per-plugin wrappers (topic-prefix-enforced bus, id-auto-
    // prefixed ui) so plugins can't fire bus events outside their namespace
    // or collide DOM ids with other plugins.
    const gated = buildGatedSb(realSb, granted);
    const finalSb: SbApi = {
      ...gated,
      bus: granted.has(Capability.Bus)
        ? createPluginBus(realSb.bus, bundle.id, pluginScope.signal)
        : (undefined as never),
      ui: granted.has(Capability.Ui)
        ? createPluginUi(realSb.ui, bundle.id)
        : (undefined as never),
    };

    return {
      pluginId: bundle.id,
      contextKind: currentKind,
      apiVersion: bundle.apiVersion,
      granted,
      sb: finalSb,
      scope: pluginScope,
      configs: granted.has(Capability.Configs)
        ? createPluginConfigs(bridge, bundle.id)
        : (undefined as never),
      log: createPluginLog(bundle.id, (op, pid, args2) => bridge.notify(op, pid, args2 as object)),
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
