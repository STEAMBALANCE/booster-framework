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

/** Invisible best-effort capture of the store country. No-op unless we're on
 *  the store origin (only there can /account/ be fetched same-origin). Reads
 *  steamId from g_AccountID, fetches /account/?l=english, parses + maps the
 *  country, and pushes {steamId, country} to C++. Fire-and-forget; all errors
 *  swallowed (never throws, never rejects upstream). */
export function maybeCaptureStoreCountry(bridge: Bridge, scope: ScopeApi): void {
  if (typeof location === 'undefined' || location.origin !== STORE_ORIGIN) return;
  const steamId = readCurrentSteamId64FromStoreGlobal();
  if (!steamId) return;
  void (async () => {
    try {
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
