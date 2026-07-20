import type { SteamApi } from './api/api-types';
import type { Bridge } from './bridge';

// Production user-binding diagnostic: one native log line ties a submitted
// support log to a user. Logs login plus the account's store country and
// currency — these say whether region/currency detection actually worked for
// this user (a common support question), and are regional aggregates, not
// identity. email/steamId/balance are still never logged. Timeout-bounded so a
// non-logged-in Steam doesn't keep the promise alive for the session.
export function reportUserBinding(steam: SteamApi, bridge: Bridge): void {
  void (async () => {
    const user = await Promise.race([
      steam.getCurrentUserAsync(),
      new Promise<null>((res) => setTimeout(() => res(null), 5000)), // global setTimeout (not scope-bound) so it survives scope.abort
    ]);
    if (!user) return;
    // Best-effort; either may be undefined (cold relay, older client) — send
    // null so the log line distinctly shows "could not determine".
    let country: string | null = null;
    try { country = (await steam.getStoreCountry?.()) ?? null; } catch { /* keep null */ }
    bridge.call('logUserData', {
      login: user.accountName,
      country,
      currency: user.currency ?? null,
    }).catch(() => { /* bridge unavailable in early boot is OK */ });
  })().catch(() => { /* */ });
}
