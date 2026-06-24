// sb.context — per-target read-only metadata (kind, live URL).
//
// `kind` is fixed at construction from the C++-injected prefix
// (__SB_PLUGINS_MANIFEST__.contextKind) and read by readContextKind()
// below before this API is built.
//
// `url` is reactive: we patch History.pushState / History.replaceState and
// listen for popstate / hashchange so any SPA navigation in the host page
// notifies subscribers. The patch uses a `__sb_native` marker so a second
// injection that happens before the first has torn down (cross-injection
// re-patch during rollback / re-injection windows) does NOT stack —
// new patch always wraps the original native fn, and the previous wrapper
// is dropped when its scope aborts.

import type { SbContextApi, ContextKind } from './api-types';
import { ContextKind as CK } from './api-types';
import type { ScopeApi } from './scope';
import { nativeWarn } from '../native-warn';

const VALID_KINDS: ReadonlyArray<ContextKind> =
  [CK.Main, CK.Shared, CK.TabbedBrowser, CK.Web];

// Mirrors the native injector's Steam host allow-list (target classification).
// Used only for the defensive fallback in readContextKind — if contextKind
// is missing/invalid we use the host to make a better guess than blindly
// defaulting to CK.Main on a web target where the SharedContext relay
// isn't reachable cross-origin.
const STEAM_WEB_HOSTS: ReadonlyArray<string> = [
  'store.steampowered.com',
  'steamcommunity.com',
  'help.steampowered.com',
];

function defaultKindFromHost(): ContextKind {
  try {
    const host = (location.host ?? '').toLowerCase();
    // Strip port if present (C++ ExtractHostStrict canonicalises the same way).
    const colonIdx = host.indexOf(':');
    const hostOnly = colonIdx >= 0 ? host.slice(0, colonIdx) : host;
    if (STEAM_WEB_HOSTS.includes(hostOnly)) return CK.Web;
  } catch { /* location may be unavailable in some test contexts */ }
  return CK.Main;
}

/**
 * Reads contextKind from the C++-injected JS prefix global. Set per-session
 * by BuildFrameworkJsWithConfig based on which target the framework was
 * injected into (main, shared, tabbedBrowser, web).
 *
 * Missing or invalid → host-disambiguated fallback + native-warn log.
 * Bootstrap uses this to pick the right makeContextApi(scope, kind) argument.
 *
 * The fallback inspects `location.host`: Steam web hosts (store / community /
 * help) → ContextKind.Web; anything else → ContextKind.Main. This guards
 * against a future C++ regression that fails to set contextKind on a web
 * target — without the host check, the framework would silently run as main
 * on store.steampowered.com where the SharedContext relay isn't reachable
 * cross-origin.
 */
export function readContextKind(): ContextKind {
  const cfg = (globalThis as { __SB_PLUGINS_MANIFEST__?: { contextKind?: unknown } })
    .__SB_PLUGINS_MANIFEST__;
  const k = cfg?.contextKind;
  if (typeof k === 'string' && (VALID_KINDS as readonly string[]).includes(k)) {
    return k as ContextKind;
  }
  const fallback = defaultKindFromHost();
  nativeWarn(
    'readContextKind: missing or invalid contextKind, host-disambiguated fallback',
    { got: String(k), fallback },
  );
  return fallback;
}

type PatchedFn = History['pushState'] & { __sb_native?: History['pushState'] };

export function makeContextApi(
  scope: ScopeApi,
  kind: ContextKind,
): SbContextApi {
  let currentUrl = location.href;
  const listeners = new Set<(url: string) => void>();

  function fire(): void {
    const u = location.href;
    if (u === currentUrl) return;
    currentUrl = u;
    for (const cb of listeners) {
      try { cb(u); } catch { /* swallow — one bad listener mustn't break the rest */ }
    }
  }

  // Patch with __sb_native guard so cross-injection re-patches don't stack.
  // If a previous injection's wrapper is still installed, we strip down to
  // its native fn and wrap that — when scope1 aborts later, it restores
  // its captured native (which is the true native, not scope2's wrapper).
  const curPush    = history.pushState    as PatchedFn;
  const curReplace = history.replaceState as PatchedFn;
  const nativePush    = curPush.__sb_native    ?? curPush;
  const nativeReplace = curReplace.__sb_native ?? curReplace;

  const newPush: PatchedFn = function (this: History, ...args) {
    const r = nativePush.apply(this, args as Parameters<History['pushState']>);
    queueMicrotask(fire);
    return r;
  };
  newPush.__sb_native = nativePush;
  const newReplace: PatchedFn = function (this: History, ...args) {
    const r = nativeReplace.apply(this, args as Parameters<History['replaceState']>);
    queueMicrotask(fire);
    return r;
  };
  newReplace.__sb_native = nativeReplace;
  history.pushState    = newPush;
  history.replaceState = newReplace;

  scope.signal.addEventListener('abort', () => {
    // Only restore if our wrapper is still installed. A later injection may
    // have re-wrapped on top of us; in that case our wrapper is preserved
    // inside their __sb_native chain and they will eventually restore.
    if (history.pushState === newPush)       history.pushState    = nativePush;
    if (history.replaceState === newReplace) history.replaceState = nativeReplace;
  }, { once: true });

  const onPop  = () => fire();
  const onHash = () => fire();
  window.addEventListener('popstate',    onPop);
  window.addEventListener('hashchange',  onHash);
  scope.signal.addEventListener('abort', () => {
    window.removeEventListener('popstate',   onPop);
    window.removeEventListener('hashchange', onHash);
  }, { once: true });

  return {
    kind,
    get url() { return currentUrl; },
    onUrlChange(cb: (url: string) => void): () => void {
      listeners.add(cb);
      // Initial-fire deferred via queueMicrotask — caller can unsubscribe
      // before the initial fire if they wish (the `!listeners.has(cb)`
      // guard inside the microtask honours that). The deferred contract
      // lets ctx.onUrlChange handlers that unsubscribe themselves on
      // first match do so cleanly.
      queueMicrotask(() => {
        if (!listeners.has(cb)) return; // unsubscribed before microtask ran
        try { cb(currentUrl); } catch { /* swallow */ }
      });
      return () => { listeners.delete(cb); };
    },
  };
}
