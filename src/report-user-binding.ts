import type { SteamApi } from './api/api-types';
import type { Bridge } from './bridge';

// Production user-binding diagnostic: one native log line ties a submitted
// support log to a user. Login only — email/steamId/balance/currency are
// intentionally never logged (CLAUDE.md PII policy). Timeout-bounded so a
// non-logged-in Steam doesn't keep the promise alive for the session.
export function reportUserBinding(steam: SteamApi, bridge: Bridge): void {
  void (async () => {
    const user = await Promise.race([
      steam.getCurrentUserAsync(),
      new Promise<null>((res) => setTimeout(() => res(null), 5000)), // global setTimeout (not scope-bound) so it survives scope.abort
    ]);
    if (!user) return;
    bridge.call('logUserData', { login: user.accountName })
      .catch(() => { /* bridge unavailable in early boot is OK */ });
  })().catch(() => { /* */ });
}
