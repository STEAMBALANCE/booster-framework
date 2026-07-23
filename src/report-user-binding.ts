import type { SteamApi } from './api/api-types';
import type { Bridge } from './bridge';
import { currencyForStoreCountry } from './steam-internals/country-to-currency';

// Bounded confirm-poll config (env-overridable for tests).
function confirmIntervalMs(): number {
  if (typeof process === 'undefined') return 15000;
  const v = Number(process.env['SB_USER_BINDING_CONFIRM_INTERVAL_MS']);
  return Number.isFinite(v) && v > 0 ? v : 15000;
}
function confirmAttempts(): number {
  if (typeof process === 'undefined') return 20;
  const v = Number(process.env['SB_USER_BINDING_CONFIRM_ATTEMPTS']);
  return Number.isFinite(v) && v >= 0 ? v : 20;
}

// Production user-binding diagnostic: one native log line ties a submitted
// support log to a user. Logs login plus the account's store country and
// currency — these say whether region/currency detection actually worked for
// this user (a common support question), and are regional aggregates, not
// identity. email/steamId/balance are still never logged. Timeout-bounded so a
// non-logged-in Steam doesn't keep the promise alive for the session. On a
// fresh install region/currency can log as "(none)" at boot if the store
// hasn't been visited yet; a bounded poll re-checks the live store-country
// cache and emits ONE confirming line once both resolve. The poll is bound to
// `signal`: on framework hot-update/rollback the scope aborts and the poller
// stops within one interval, so a stale poller from a rolled-back framework
// instance never emits — worst case `confirmAttempts() × confirmIntervalMs()`
// if it's never aborted or resolved.
export function reportUserBinding(steam: SteamApi, bridge: Bridge, signal?: AbortSignal): void {
  void (async () => {
    const user = await Promise.race([
      steam.getCurrentUserAsync(),
      new Promise<null>((res) => setTimeout(() => res(null), 5000)), // global setTimeout (not scope-bound) so it survives scope.abort
    ]);
    if (!user) return;

    // Resolve region + currency from the current store-country cache. Currency
    // prefers the wallet balance string, then falls back to the store country.
    const resolve = async (): Promise<{ country: string | null; currency: string | null }> => {
      let country: string | null = null;
      try { country = (await steam.getStoreCountry?.()) ?? null; } catch { /* keep null */ }
      const currency = user.currency ?? currencyForStoreCountry(country ?? undefined) ?? null;
      return { country, currency };
    };
    const emit = (r: { country: string | null; currency: string | null }): void => {
      bridge.call('logUserData', { login: user.accountName, country: r.country, currency: r.currency })
        .catch(() => { /* bridge unavailable in early boot is OK */ });
    };

    const first = await resolve();
    emit(first);
    // Fully determined at boot (returning user, store country already cached) → done.
    if (first.country && first.currency) return;

    // Otherwise poll a bounded number of times; emit ONE confirming line the
    // moment both region and currency are determined (e.g. after the user's
    // first store visit this session populates the cache), then stop.
    for (let i = 0; i < confirmAttempts(); i++) {
      await new Promise((res) => setTimeout(res, confirmIntervalMs()));
      if (signal?.aborted) return;                 // framework rolled back — stop the stale poller
      const next = await resolve();
      if (signal?.aborted) return;
      if (next.country && next.currency) { emit(next); return; }
    }
  })().catch(() => { /* */ });
}
