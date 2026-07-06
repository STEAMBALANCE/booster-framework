/**
 * Reads and deletes the `_sec` field from `window.__SB_PLUGINS_MANIFEST__`
 * exactly once, at framework bootstrap start.
 *
 * The injector (A3) emits `_sec.frameworkToken` into the manifest prefix
 * BEFORE evaluating framework/plugin bundles. This helper must be called
 * before the plugin drain and before any plugin eval — satisfied because the
 * framework IIFE (index.ts bootstrap) runs synchronously before plugin
 * Runtime.evaluate calls.
 *
 * Return type is designed to be extended by Plans B/C with additional fields
 * (`resolverName`, `busDispatchName`, `relaySecret`) without rewriting callers.
 */
export interface SecContext {
  frameworkToken?: string;
  resolverName?: string;
  busDispatchName?: string;
  relaySecret?: string;
  /** Per-launch secret name for the JS keys-activate global. When set, the
   *  main-shell bootstrap registers `window[keysActivate]` as a non-enumerable
   *  delegate to `api.keys.activate` so the native host.activateKey handler
   *  can reach it without relying on the minimal window.sb facade. */
  keysActivate?: string;
  /** Per-launch secret name for the JS rate-account collector global. When set,
   *  the main-shell bootstrap registers `window[rateAccountData]` as a
   *  non-enumerable delegate to `collectRatePayload(api)` so the native
   *  host.getRateAccountData handler can reach it without relying on the
   *  minimal window.sb facade. */
  rateAccountData?: string;
}

export function readAndConsumeSec(): SecContext {
  const manifest = (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__;
  if (!manifest || typeof manifest !== 'object') return {};
  const obj = manifest as Record<string, unknown>;
  const sec = obj['_sec'];
  if (!sec || typeof sec !== 'object') return {};
  const secObj = sec as Record<string, unknown>;
  const frameworkToken = typeof secObj['frameworkToken'] === 'string'
    ? secObj['frameworkToken']
    : undefined;
  const resolverName = typeof secObj['resolverName'] === 'string'
    ? secObj['resolverName']
    : undefined;
  const busDispatchName = typeof secObj['busDispatchName'] === 'string'
    ? secObj['busDispatchName']
    : undefined;
  const relaySecret = typeof secObj['relaySecret'] === 'string'
    ? secObj['relaySecret']
    : undefined;
  const keysActivate = typeof secObj['keysActivate'] === 'string'
    ? secObj['keysActivate']
    : undefined;
  const rateAccountData = typeof secObj['rateAccountData'] === 'string'
    ? secObj['rateAccountData']
    : undefined;
  delete obj['_sec'];
  return { frameworkToken, resolverName, busDispatchName, relaySecret, keysActivate, rateAccountData };
}
