import { createRegistry } from './registry';
import { createBridge, createTokenBridge } from './bridge';
import { makeUiApi } from './api/ui';
import { makeSteamApi } from './api/steam';
import { makeLifecycleApi } from './api/lifecycle';
import { createScope } from './api/scope';
import { makeConfigsApi } from './api/configs';
import { makeContextApi, readContextKind } from './api/context';
import { makePagesApi } from './api/pages';
import { makeBusApi } from './api/bus';
import { makeKeysApi } from './api/keys';
import { makeNetApi } from './api/net';
import { makeAppApi } from './api/app';
import { maybeCaptureStoreCountry } from './steam-internals/capture-store-country';
import { createPluginsApi } from './api/plugins';
import { PluginRegistry } from './plugins/registry';
import { drainPluginsOnReady, readPluginsManifest } from './plugins/bootstrap';
import { startRelay } from './relay/shared-context';
import { nativeWarn } from './native-warn';
import { reportUserBinding } from './report-user-binding';
import { prefetchSetupId } from './prefetch-setup-id';
import { readAndConsumeSec } from './sec';
import { collectRatePayload } from './rate-account';
import type { SbApi } from './api/api-types';

declare const __SB_FRAMEWORK_VERSION__: string;
declare const __SB_PRODUCTION__: boolean;

/** Minimal registration facade exposed on window.sb.
 *  The full SbApi is per-plugin via ctx.sb (capability-gated). */
interface SbRegistrationFacade {
  readonly plugins: { readonly register: SbApi['plugins']['register'] };
}

declare global {
  interface Window {
    sb?: SbRegistrationFacade;
    // Internal re-injection handle. Set by THIS bootstrap; read by the NEXT
    // bootstrap's rollback block. Not part of the plugin-visible API.
    // _pluginOutcomes: dev diagnostic set by drainPluginsOnReady; accessible
    // as globalThis.__sb_internal._pluginOutcomes after the drain completes.
    __sb_internal?: { rollbackAll: () => void; teardown: () => void; _pluginOutcomes?: unknown[] };
    // __sb_relay_started and __sb_relay_teardown are declared on the Window
    // interface in framework/src/relay/shared-context.ts. We rely on the
    // declaration-merging from the import above so we don't have to
    // re-declare them here.
  }
}

(function bootstrap() {
  // Detection: SharedJSContext targets expose MainWindowBrowserManager.
  // The main shell has the toolbar DOM but no MWBM.
  // (See validation log §Spike-4 — global availability table.)
  const isSharedContext =
    typeof (window as unknown as { MainWindowBrowserManager?: unknown }).MainWindowBrowserManager !==
    'undefined';

  // Fresh AbortController-backed scope for THIS injection. Relay (SharedJSContext)
  // and full framework (MainShell) both use it. The OLD scope (if any) lives on
  // the OLD window.sb (MainShell) or in the OLD startRelay closure
  // (SharedJSContext); both are aborted by the rollback paths below.
  const scope = createScope();

  // Reset stale guards from previous framework injection. The page JS context
  // outlives steambooster.exe restarts (Steam keeps the page alive); without a
  // reset the previous version's handlers stay live but never see new
  // request types added in the current build. We always want THIS injection's
  // handlers to be the active ones.
  // SharedJSContext path: tear down the prior relay BEFORE clearing the guard,
  // so the old BC subscription stops responding. Without this, every relay
  // request gets one response per still-attached relay → bridge/promise
  // resolves correctly on the first message, but main shell sees duplicate
  // BC traffic and ui.ts's `pending` map drops the second/third response
  // silently. (Correctness issue more than a hang, but it surfaces as
  // flake on rapid steambooster restarts.)
  if (typeof window.__sb_relay_teardown === 'function') {
    try {
      window.__sb_relay_teardown();
    } catch (e) {
      // Teardown that throws leaves the relay in undefined state — log
      // loudly so we catch it. nativeWarn is safe to call even if the
      // bridge isn't yet wired (no-op fallback).
      nativeWarn('prior __sb_relay_teardown threw', { error: String(e) });
    }
  }
  window.__sb_relay_started = false;
  // Resolve the prior injection's rollback handle. THIS branch records it on
  // window.__sb_internal; the currently-deployed (pre-this-branch) framework
  // recorded it on window.sb.lifecycle instead (no __sb_internal). On the
  // FIRST in-place hot-update / self-update that deploys this branch over a
  // page still running the old framework, fall back to the legacy handle so
  // the old injection is still rolled back for that one-time transition.
  const legacyLifecycle = (window.sb as unknown as
    { lifecycle?: { rollbackAll?: () => void } } | undefined)?.lifecycle;
  if (window.__sb_internal || typeof legacyLifecycle?.rollbackAll === 'function') {
    // rollbackAll aborts the OLD scope (its own AbortController) and
    // removes DOM mutations from the prior injection (header buttons,
    // popups). Without this, an old button stays in the toolbar but its
    // click handler is closure-bound to the OLD bridge instance, whose
    // `pending` Map and __sb_resolve closure are now orphaned: any bridge
    // call from the old button hangs until 10s timeout because the current
    // __sb_resolve points to THIS injection's resolver, which has no record
    // of the old requestId. Clearing those mutations forces addHeaderButton
    // (called by the freshly-evaluated plugin) to insert a button wired to
    // the live bridge.
    try {
      if (window.__sb_internal) {
        window.__sb_internal.rollbackAll();
      } else {
        legacyLifecycle!.rollbackAll!();
      }
    } catch (e) {
      nativeWarn('prior rollbackAll threw', { error: String(e) });
    }
    try {
      // writable:true here so the next defineProperty (line below) can
      // overwrite — even though the prior writable:false locked the slot,
      // configurable:true on the prior define lets us redefine fully.
      Object.defineProperty(window, 'sb', { value: undefined, writable: true, configurable: true });
    } catch {
      // configurable was false on a prior injection (shouldn't happen, but safe-guard)
    }
  }

  if (isSharedContext) {
    // SharedJSContext: relay only, no window.sb.
    // Read+delete _sec BEFORE startRelay so the relay can bind its bridge
    // to the framework token (external-window / native ops attribution).
    const sec = readAndConsumeSec();
    startRelay(scope, sec);
    return;
  }

  // Read+delete _sec from __SB_PLUGINS_MANIFEST__ BEFORE createBridge and
  // before the plugin drain. The injector (A3) emits frameworkToken here.
  // Must run synchronously so plugin bundles (evaluated in later
  // Runtime.evaluate calls) never see the _sec field.
  const sec = readAndConsumeSec();

  // contextKind is sourced from the C++-injected prefix
  // (__SB_PLUGINS_MANIFEST__.contextKind). Falls back to ContextKind.Main with
  // a native-warn if missing/invalid (see readContextKind). Read before
  // building the sb facade so context/pages all see the same kind.
  const contextKind = readContextKind();

  const registry = createRegistry();
  const bridge = createBridge(undefined, { resolverName: sec.resolverName });
  // Framework identity bridge: stamps frameworkToken on every native IPC
  // envelope so the native router (A5/A6) attributes framework-internal ops
  // to the framework identity (is_framework=true → all caps). Falls back to
  // the base bridge (no token) when running against a pre-A3 injector.
  const fwBridge = sec.frameworkToken
    ? createTokenBridge(bridge, sec.frameworkToken, 'booster-framework')
    : bridge;
  const lifecycle = makeLifecycleApi(registry, scope);
  const context = makeContextApi(scope, contextKind);
  const pages = makePagesApi(scope, context);
  const bus = makeBusApi(scope, fwBridge, sec.busDispatchName);
  const ui = makeUiApi(registry, fwBridge, sec.relaySecret);
  const steam = makeSteamApi(registry, fwBridge, sec.relaySecret);
  const configs = makeConfigsApi(fwBridge);
  const keys = makeKeysApi(registry, sec.relaySecret);
  const net = makeNetApi(fwBridge);
  const app = makeAppApi(fwBridge);
  // Invisible store-country capture. No-op unless this context is on
  // store.steampowered.com (only there is /account/ fetchable same-origin).
  maybeCaptureStoreCountry(fwBridge, scope);

  // Plugin registry: populated by plugin calls to sb.plugins.register().
  // Drained after lifecycle._markReady() below — see drainPluginsOnReady.
  const pluginRegistry = new PluginRegistry();
  let pluginsReadyResolve!: () => void;
  const pluginsReadyPromise = new Promise<void>((r) => { pluginsReadyResolve = r; });
  const plugins = createPluginsApi(pluginRegistry, { ready: pluginsReadyPromise });

  // Mutable lifecycle-state holder. Exposed through a getter on the api
  // object below so the value can transition loading → ready without
  // rebuilding the facade. 'disabled' is a forward-compat union member
  // for a manifest kill-switch — not yet surfaced (no plumbing flips
  // state to 'disabled' today).
  let lifecycleState: SbApi['state'] = 'loading';

  const api: SbApi = {
    version: __SB_FRAMEWORK_VERSION__,
    get state() { return lifecycleState; },
    context,
    app,
    ui,
    steam,
    lifecycle,
    scope,
    configs,
    pages,
    bus,
    plugins,
    keys,
    net,
  };
  // Defense-in-depth: freeze the api object so no code in this bootstrap
  // or a plugin can add/remove/replace properties. The `lifecycleState`
  // local variable is NOT a property of api — it's captured in the getter
  // closure — so this freeze does not prevent state transitions.
  Object.freeze(api);

  // Expose a frozen minimal facade — plugins call sb.plugins.register() from
  // their top-level code. The full SbApi lives in the bootstrap closure and
  // is passed per-plugin via ctx.sb (capability-gated). configurable:true
  // preserves hot-reinject-ability (next bootstrap clears + redefines).
  Object.defineProperty(window, 'sb', {
    value: Object.freeze({ plugins: Object.freeze({ register: api.plugins.register }) }),
    writable: false,
    configurable: true,
  });
  // __sb_internal carries the re-injection handles. The next bootstrap reads
  // this instead of window.sb.lifecycle so that rollbackAll remains reachable
  // even though window.sb no longer exposes lifecycle.
  // _pluginOutcomes getter: exposes the drain result for dev diagnostics
  // (globalThis.__sb_internal._pluginOutcomes) once drainPluginsOnReady sets
  // it on api. Returns undefined until the drain completes.
  window.__sb_internal = {
    rollbackAll: () => api.lifecycle.rollbackAll(),
    teardown: () => {},
    get _pluginOutcomes() { return (api as unknown as { _pluginOutcomes?: unknown[] })._pluginOutcomes; },
  };

  // Register the per-launch secret keys-activate fn. The injector emits
  // _sec.keysActivate so the native host.activateKey handler can invoke
  // api.keys.activate without relying on the minimal window.sb facade.
  // Non-enumerable so it doesn't appear in Object.keys(window) scans.
  if (sec.keysActivate) {
    Object.defineProperty(window, sec.keysActivate, {
      value: (k: string) => api.keys.activate(k),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }

  // Register the per-launch secret rate-account collector fn. The injector emits
  // _sec.rateAccountData so the native host.getRateAccountData handler can invoke
  // collectRatePayload(api) without relying on the minimal window.sb facade.
  // Non-enumerable so it doesn't appear in Object.keys(window) scans.
  if (sec.rateAccountData) {
    Object.defineProperty(window, sec.rateAccountData, {
      value: () => collectRatePayload(api, Date.now()),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }

  // Global error / unhandled-rejection forwarders. Routed through scope.listen
  // so they auto-detach on rollbackAll — without that, the OLD injection's
  // listener stays alive, sees a NEW injection's error, and tries to log it
  // through the OLD (now-dead) bridge.
  scope.listen<ErrorEvent>(window, 'error', (ev) => {
    fwBridge.notify('log', 'booster-framework', {
      level: 'error',
      msg: ev.message,
      meta: {
        filename: ev.filename,
        lineno: ev.lineno,
        stack: ev.error instanceof Error ? ev.error.stack : undefined,
      },
    });
  });
  scope.listen<PromiseRejectionEvent>(window, 'unhandledrejection', (ev) => {
    fwBridge.notify('log', 'booster-framework', {
      level: 'error',
      msg: 'unhandled rejection',
      meta: { reason: String(ev.reason) },
    });
  });

  lifecycle._markReady();
  lifecycleState = 'ready';

  // Drain the plugin registry on lifecycle.ready(). The .then() resolves
  // on the next microtask after _markReady(); by that point each plugin
  // bundle (which is evaluated by the injector in a separate Runtime.evaluate
  // call AFTER the framework IIFE returns) has had a chance to call
  // sb.plugins.register(). Phase D wires the actual __SB_PLUGINS_MANIFEST__
  // emitter in the native injector's injection prefix; until then readPluginsManifest()
  // returns undefined and drainPluginsOnReady resolves with empty outcomes
  // after logging a diagnostic.
  void api.lifecycle.ready().then(async () => {
    try {
      await drainPluginsOnReady({
        registry: pluginRegistry,
        manifest: readPluginsManifest(),
        realSb: api,
        bridge,
        currentUrl: location.href,
      });
    } catch (e) {
      nativeWarn('drainPluginsOnReady threw', { error: String(e) });
    } finally {
      pluginsReadyResolve();
    }
  });

  reportUserBinding(steam, fwBridge);
  prefetchSetupId(api.app, window as { __SB_BOOSTER_UUID__?: string });
})();

// Re-export the public API surface so the npm entry (dist/index.js ESM +
// dist/index.d.ts) carries `ContextKind`, `Capability`, `PurchaseResultDetail`,
// `CURRENT_API_VERSION` and all public types for tsc/non-bun consumers. The
// IIFE bundle (out/booster-framework.js) drops these re-exports — injection is
// unaffected. The `exports."."` `bun` condition still points at
// src/api/api-types.ts directly, so plugin authors never resolve this
// side-effectful bootstrap module at runtime.
export * from './api/api-types';
