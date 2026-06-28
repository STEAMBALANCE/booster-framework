import { createRegistry } from './registry';
import { createBridge } from './bridge';
import { makeUiApi } from './api/ui';
import { makeSteamApi } from './api/steam';
import { makeLifecycleApi } from './api/lifecycle';
import { createScope } from './api/scope';
import { makeConfigsApi } from './api/configs';
import { makeContextApi, readContextKind } from './api/context';
import { makePagesApi } from './api/pages';
import { makeBusApi } from './api/bus';
import { makeKeysApi } from './api/keys';
import { makeAppApi } from './api/app';
import { maybeCaptureStoreCountry } from './steam-internals/capture-store-country';
import { createPluginsApi } from './api/plugins';
import { PluginRegistry } from './plugins/registry';
import { drainPluginsOnReady, readPluginsManifest } from './plugins/bootstrap';
import { startRelay } from './relay/shared-context';
import { nativeWarn } from './native-warn';
import { reportUserBinding } from './report-user-binding';
import { prefetchSetupId } from './prefetch-setup-id';
import { buildGlobalSb, type GlobalSbApi } from './plugins/capability-gating';
import type { SbApi } from './api/api-types';

declare const __SB_FRAMEWORK_VERSION__: string;
declare const __SB_PRODUCTION__: boolean;

declare global {
  interface Window {
    sb?: GlobalSbApi;
    __sb_framework_rollback?: () => void;
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
  const priorRollback =
    typeof window.__sb_framework_rollback === 'function'
      ? window.__sb_framework_rollback
      : (window.sb as unknown as { lifecycle?: { rollbackAll?: () => void } } | undefined)
          ?.lifecycle?.rollbackAll;
  if (priorRollback) {
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
      priorRollback();
    } catch (e) {
      nativeWarn('prior sb.lifecycle.rollbackAll threw', { error: String(e) });
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
  try {
    Object.defineProperty(window, 'sb', { value: undefined, writable: true, configurable: true });
  } catch {
    // configurable was false on a prior injection (shouldn't happen, but safe-guard)
  }
  try {
    Object.defineProperty(window, '__sb_framework_rollback', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  } catch {
    // best-effort hot-reinject cleanup
  }

  if (isSharedContext) {
    // SharedJSContext: relay only, no window.sb
    startRelay(scope);
    return;
  }

  // contextKind is sourced from the C++-injected prefix
  // (__SB_PLUGINS_MANIFEST__.contextKind). Falls back to ContextKind.Main with
  // a native-warn if missing/invalid (see readContextKind). Read before
  // building the sb facade so context/pages all see the same kind.
  const contextKind = readContextKind();

  const registry = createRegistry();
  const bridge = createBridge();
  const lifecycle = makeLifecycleApi(registry, scope);
  const context = makeContextApi(scope, contextKind);
  const pages = makePagesApi(scope, context);
  const bus = makeBusApi(scope, bridge);
  const ui = makeUiApi(registry, bridge);
  const steam = makeSteamApi(registry, bridge);
  const configs = makeConfigsApi(bridge);
  const keys = makeKeysApi(registry);
  const app = makeAppApi(bridge);
  // Invisible store-country capture. No-op unless this context is on
  // store.steampowered.com (only there is /account/ fetchable same-origin).
  maybeCaptureStoreCountry(bridge, scope);

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
  };

  // writable:false (vs the writable:true on the temporary clear above) is
  // intentional — the prior clear is a transient unset, the final assign
  // is the real shape and we don't want a curious plugin reassigning it.
  // configurable:true preserves hot-reinject-ability (we redefine on next
  // bootstrap). Not a security boundary — gate is the Ed25519 manifest
  // signature, this is just casual defense against accidental overwrite.
  Object.defineProperty(window, 'sb', { value: buildGlobalSb(api), writable: false, configurable: true });
  Object.defineProperty(window, '__sb_framework_rollback', {
    value: () => { lifecycle.rollbackAll(); },
    writable: false,
    configurable: true,
  });

  // Global error / unhandled-rejection forwarders. Routed through scope.listen
  // so they auto-detach on rollbackAll — without that, the OLD injection's
  // listener stays alive, sees a NEW injection's error, and tries to log it
  // through the OLD (now-dead) bridge.
  scope.listen<ErrorEvent>(window, 'error', (ev) => {
    bridge.notify('log', 'booster-framework', {
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
    bridge.notify('log', 'booster-framework', {
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

  reportUserBinding(steam, bridge);
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
