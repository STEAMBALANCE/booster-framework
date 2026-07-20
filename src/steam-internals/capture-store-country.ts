// Captures the user's store/account country from store.steampowered.com.
// The relay (SharedJSContext) can't fetch /account/ (cross-origin); only a
// real store-origin context can, same-origin. Result is pushed to C++ over
// the bridge (the only cross-origin channel). See spec 2026-06-01.

/** Extract the country name from the /account/ HTML `country_settings` block.
 *  Anchored on the `country_settings` class (not on `account_data_field`
 *  order — there are several such spans on the page). Returns the raw span
 *  text (English when fetched with `?l=english`), or undefined if absent. */
export function parseStoreCountryName(html: string): string | undefined {
  if (!html) return undefined;
  const m = html.match(/country_settings[\s\S]{0,400}?account_data_field[^>]*>\s*([^<]{2,40})</);
  const name = m?.[1]?.trim();
  return name ? name : undefined;
}

import type { Bridge } from '../bridge';
import type { ScopeApi } from '../api/scope';
import { storeCountryNameToIso } from './country-map';
import { readCurrentSteamId64FromStoreGlobal } from './steam-id';

const STORE_ORIGIN = 'https://store.steampowered.com';

// Env overrides for deterministic, fast tests. The store page sets g_AccountID
// from its own inline scripts, which run AFTER our doc-start injection, so a
// single read almost always misses on a fresh navigation — poll for it.
function pollMaxMs(): number {
  if (typeof process === 'undefined') return 8000;
  const env = Number(process.env['SB_STORE_COUNTRY_POLL_MAX_MS']);
  return Number.isFinite(env) && env > 0 ? env : 8000;
}
function pollIntervalMs(): number {
  if (typeof process === 'undefined') return 250;
  const env = Number(process.env['SB_STORE_COUNTRY_POLL_INTERVAL_MS']);
  return Number.isFinite(env) && env > 0 ? env : 250;
}

/** Poll for the store steamId until it appears or the deadline passes.
 *  Resolves undefined if it never shows (not signed in / not a store page). */
function waitForStoreSteamId(scope: ScopeApi): Promise<string | undefined> {
  const immediate = readCurrentSteamId64FromStoreGlobal();
  if (immediate) return Promise.resolve(immediate);
  const budget = pollMaxMs();
  const interval = pollIntervalMs();
  return new Promise((resolve) => {
    let waited = 0;
    const tick = (): void => {
      const id = readCurrentSteamId64FromStoreGlobal();
      if (id) { resolve(id); return; }
      waited += interval;
      if (waited >= budget) { resolve(undefined); return; }
      scope.setTimeout(tick, interval);
    };
    scope.setTimeout(tick, interval);
  });
}

/** Invisible best-effort capture of the store country. No-op unless we're on
 *  the store origin (only there can /account/ be fetched same-origin). Waits
 *  for g_AccountID (set by the page after our injection), fetches
 *  /account/?l=english, parses + maps the country, and pushes {steamId, country}
 *  to C++. Fire-and-forget; all errors swallowed (never throws / rejects). */
export function maybeCaptureStoreCountry(bridge: Bridge, scope: ScopeApi): void {
  if (typeof location === 'undefined' || location.origin !== STORE_ORIGIN) return;
  void (async () => {
    try {
      const steamId = await waitForStoreSteamId(scope);
      if (!steamId) return;
      const res = await scope.fetch('/account/?l=english');
      if (!res.ok) return;
      const name = parseStoreCountryName(await res.text());
      if (!name) return;
      const country = storeCountryNameToIso(name);
      if (!country) return;
      await bridge.call('set_store_country', { steamId, country });
    } catch { /* best-effort: never throw */ }
  })();
}
