import type { SteamApi, SteamUser, MachineId } from './api-types';
import type { Registry } from '../registry';
import type { Bridge } from '../bridge';
import { RELAY_CHANNEL } from '../relay/protocol';
import { deriveCurrency, parseBalanceNumber } from '../steam-internals/currency-map';
import { readCurrentSteamId64FromStoreGlobal } from '../steam-internals/steam-id';
import { isUrlSafeForNavigation, safeHostForLog } from '../navigation-safety';
import { readRelayAuthToken, withRelayAuth } from '../relay/auth';

export { isUrlSafeForNavigation } from '../navigation-safety';

// Window.SteamClient shape is declared in relay/shared-context.ts (merged interface).

const RELAY_TIMEOUT_MS = 5000;

// Separate id space from ui.ts (which caps at <100_000) to avoid collisions
// on the same BC channel. Each makeSteamApi() instance gets its own counter
// starting here.
const STEAM_REQUEST_ID_BASE = 100_000;

/** Read at call-time so tests can override via env-var without import-time
 *  pinning. Production CEF lacks `process` — defaults to 5000ms. */
function getUserExtraTimeoutMs(): number {
  if (typeof process === 'undefined') return 5000;
  const env = Number(process.env['SB_USER_EXTRA_RELAY_TIMEOUT_MS']);
  return Number.isFinite(env) && env > 0 ? env : 5000;
}

// Bounded wait for the first user-snapshot when resolving steamId for
// getStoreCountry from a cold context. Short — getStoreCountry is best-effort.
// Read at call-time (env override) so the rollback test can shorten it.
function getStoreCountrySteamIdWaitMs(): number {
  if (typeof process === 'undefined') return 3000;
  const env = Number(process.env['SB_STORE_COUNTRY_STEAMID_WAIT_MS']);
  return Number.isFinite(env) && env > 0 ? env : 3000;
}


interface SnapshotPayload {
  accountName: string;
  personaName?: string;
  steamId?: string;
  balanceFormatted?: string;
  isLimited?: boolean;
  isOfflineMode?: boolean;
}

export function makeSteamApi(registry: Registry, bridge: Bridge): SteamApi {
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const relayAuthToken = readRelayAuthToken();
  const postRelay = (msg: Record<string, unknown>): void => {
    bc.postMessage(withRelayAuth(msg, relayAuthToken));
  };
  let nextRequestId = STEAM_REQUEST_ID_BASE;
  // Heterogeneous resolve type: navigate resolves void. Each call site owns
  // its narrow signature via the closure that wraps `pending.set(...)`.
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  // Cache state. `cachedUser` is populated by `user-snapshot` BC events from
  // the relay (pushed on login, on user changes, and on `request-snapshot`
  // handshake). Cleared on registry rollback.
  let cachedUser: SteamUser | null = null;
  const userChangeListeners = new Set<(u: SteamUser | null) => void>();

  // Pending getCurrentUserAsync resolvers — rejected on registry rollback so
  // callers don't hang forever past framework teardown.
  const userAsyncPending = new Set<{
    resolve: (u: SteamUser) => void;
    reject: (e: Error) => void;
    handler: (u: SteamUser | null) => void;
  }>();

  // Separate id space from openUrl (STEAM_REQUEST_ID_BASE = 100_000) so async
  // getter responses can't be misrouted to the openUrl pending map. Declared
  // inside the closure so each makeSteamApi() instance has its own counter,
  // not shared across instances.
  let userExtraNextRequestId = 200_000;

  function callRelayGetAccountSettings(): Promise<{ email?: string; emailValidated?: boolean }> {
    return new Promise((resolve) => {
      const requestId = userExtraNextRequestId++;
      const timer = setTimeout(() => {
        bc.removeEventListener('message', handler);
        resolve({});
      }, getUserExtraTimeoutMs());
      const handler = (ev: MessageEvent) => {
        const m = ev.data as { kind?: string; requestId?: number; email?: string; emailValidated?: boolean } | undefined;
        if (m?.kind !== 'user-account-settings-ok' || m?.requestId !== requestId) return;
        clearTimeout(timer);
        bc.removeEventListener('message', handler);
        resolve({ email: m.email, emailValidated: m.emailValidated });
      };
      bc.addEventListener('message', handler);
      postRelay({ kind: 'get-user-account-settings', requestId });
    });
  }

  function callRelayGetCountry(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const requestId = userExtraNextRequestId++;
      const timer = setTimeout(() => {
        bc.removeEventListener('message', handler);
        resolve(undefined);
      }, getUserExtraTimeoutMs());
      const handler = (ev: MessageEvent) => {
        const m = ev.data as { kind?: string; requestId?: number; value?: string } | undefined;
        if (m?.kind !== 'user-country-ok' || m?.requestId !== requestId) return;
        clearTimeout(timer);
        bc.removeEventListener('message', handler);
        resolve(m.value);
      };
      bc.addEventListener('message', handler);
      postRelay({ kind: 'get-user-country', requestId });
    });
  }

  function callRelayGetLanguage(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const requestId = userExtraNextRequestId++;
      const timer = setTimeout(() => {
        bc.removeEventListener('message', handler);
        resolve(undefined);
      }, getUserExtraTimeoutMs());
      const handler = (ev: MessageEvent) => {
        const m = ev.data as { kind?: string; requestId?: number; value?: string } | undefined;
        if (m?.kind !== 'user-language-ok' || m?.requestId !== requestId) return;
        clearTimeout(timer);
        bc.removeEventListener('message', handler);
        resolve(m.value);
      };
      bc.addEventListener('message', handler);
      postRelay({ kind: 'get-user-language', requestId });
    });
  }

  function callRelayGetMachineId(): Promise<MachineId | undefined> {
    return new Promise((resolve) => {
      const requestId = userExtraNextRequestId++;
      const timer = setTimeout(() => {
        bc.removeEventListener('message', handler);
        resolve(undefined);
      }, getUserExtraTimeoutMs());
      const handler = (ev: MessageEvent) => {
        const m = ev.data as { kind?: string; requestId?: number; value?: MachineId } | undefined;
        if (m?.kind !== 'machine-id-ok' || m?.requestId !== requestId) return;
        clearTimeout(timer);
        bc.removeEventListener('message', handler);
        resolve(m.value);
      };
      bc.addEventListener('message', handler);
      postRelay({ kind: 'get-machine-id', requestId });
    });
  }

  function makeSteamUserFromSnapshot(s: SnapshotPayload): SteamUser {
    const balanceFormatted = s.balanceFormatted;
    const currency = balanceFormatted ? deriveCurrency(balanceFormatted) : undefined;
    const balance  = balanceFormatted ? parseBalanceNumber(balanceFormatted) : undefined;

    // Inflight-dedupe for GetAccountSettings: a concurrent email() +
    // emailValidated() shares one BC roundtrip rather than posting two
    // requests with separate requestIds. The promise is cleared once it
    // settles so sequential calls each post a fresh BC roundtrip (matching
    // relay-side cache behaviour — relay deduplicates SteamClient calls).
    let accountSettingsPromise: Promise<{ email?: string; emailValidated?: boolean }> | null = null;
    function getAccountSettings(): Promise<{ email?: string; emailValidated?: boolean }> {
      if (accountSettingsPromise) return accountSettingsPromise;
      const p = callRelayGetAccountSettings();
      accountSettingsPromise = p;
      void p.finally(() => {
        if (accountSettingsPromise === p) accountSettingsPromise = null;
      });
      return p;
    }

    return {
      accountName:    s.accountName,
      personaName:    s.personaName,
      steamId:        s.steamId,
      balanceFormatted,
      currency,
      balance,
      isLimited:      s.isLimited,
      isOfflineMode:  s.isOfflineMode,
      // Async getters — each call triggers a BC roundtrip to the relay.
      // Concurrent calls (e.g. email() + emailValidated()) share one inflight
      // request; sequential calls each post a fresh BC message.
      email:          () => getAccountSettings().then((r) => r.email),
      emailValidated: () => getAccountSettings().then((r) => r.emailValidated),
      ipCountry:      () => callRelayGetCountry(),
      language:       () => callRelayGetLanguage(),
    };
  }

  // BC subscription must be released on framework re-injection — without
  // this hook, every prior makeSteamApi() left a live listener that fires
  // for every relay response across orphaned bridge instances.
  registry.push({
    description: 'steam-bc',
    undo: () => {
      try { bc.close(); } catch { /* */ }
      // Reject any in-flight promises so callers don't hang past rollback.
      for (const [, p] of pending) {
        try { p.reject(new Error('framework rolled back')); } catch { /* */ }
      }
      pending.clear();
      // Reject pending getCurrentUserAsync() calls so they don't hang forever.
      for (const p of userAsyncPending) {
        try { p.reject(new Error('framework rolled back')); } catch { /* */ }
      }
      userAsyncPending.clear();
      cachedUser = null;
      userChangeListeners.clear();
    },
  });

  bc.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object') return;

    // Push path: relay sent a user-snapshot (cold-start handshake reply or
    // proactive push on user change). Build SteamUser and notify listeners.
    if (msg['kind'] === 'user-snapshot') {
      const snap = msg['snapshot'] as SnapshotPayload | undefined;
      if (!snap || typeof snap.accountName !== 'string') return;
      cachedUser = makeSteamUserFromSnapshot(snap);
      for (const cb of userChangeListeners) {
        try { cb(cachedUser); } catch { /* swallow */ }
      }
      return;
    }

    // Response path: route by requestId (openUrl navigate responses).
    const requestId = typeof msg['requestId'] === 'number' ? msg['requestId'] : undefined;
    if (requestId === undefined || !pending.has(requestId)) return;
    const p = pending.get(requestId)!;
    pending.delete(requestId);
    if (msg['kind'] === 'navigate-done') p.resolve(undefined);
    else if (msg['kind'] === 'navigate-error') {
      p.reject(new Error(typeof msg['error'] === 'string' ? msg['error'] : 'navigate failed'));
    }
  });

  // Cold-start handshake — request snapshot once at construction. The relay
  // (SharedJSContext) will respond with a `user-snapshot` event containing
  // the current user's core fields. If the relay isn't up yet, the request
  // is silently dropped and the framework stays at null until relay boots and
  // broadcasts proactively.
  postRelay({ kind: 'request-snapshot' });

  async function resolveCurrentSteamId(): Promise<string | undefined> {
    if (cachedUser?.steamId) return cachedUser.steamId;
    const fromGlobal = readCurrentSteamId64FromStoreGlobal();
    if (fromGlobal) return fromGlobal;
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (v: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        userChangeListeners.delete(handler);
        resolve(v);
      };
      const handler = (u: SteamUser | null) => { if (u?.steamId) finish(u.steamId); };
      userChangeListeners.add(handler);
      const timer = setTimeout(() => finish(undefined), getStoreCountrySteamIdWaitMs());
    });
  }

  return {
    async openUrl(url: string): Promise<void> {
      // 2048 chars: well under typical browser/server URL handling limits
      // (~8 KB practical max). Payment redirect URLs are short
      // (< 1 KB); this is defensive sanity rejection, not a hard limit.
      if (typeof url !== 'string' || url.length > 2048) throw new Error('invalid url');
      if (!isUrlSafeForNavigation(url)) {
        throw new Error(`url failed safety check: ${safeHostForLog(url)}`);
      }

      const requestId = nextRequestId++;
      return new Promise<void>((resolve, reject) => {
        // Clear timer when response settles — see ui.ts relayCall comment.
        const timer = setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            reject(new Error('navigate timeout 5s'));
          }
        }, RELAY_TIMEOUT_MS);
        pending.set(requestId, {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (e: Error) => { clearTimeout(timer); reject(e); },
        });
        postRelay({ kind: 'navigate', requestId, url });
      });
    },

    getCurrentUser(): SteamUser | null {
      return cachedUser;
    },

    onUserChange(cb: (u: SteamUser | null) => void): () => void {
      // Fire immediately if cache is populated — so subscribers can init their
      // state without waiting for the next snapshot event.
      if (cachedUser !== null) {
        try { cb(cachedUser); } catch { /* swallow */ }
      }
      userChangeListeners.add(cb);
      return () => { userChangeListeners.delete(cb); };
    },

    async getCurrentUserAsync(): Promise<SteamUser> {
      if (cachedUser) return cachedUser;
      // Wait for the first non-null snapshot. The Promise is tracked in
      // userAsyncPending so it can be rejected on framework rollback
      // (instead of hanging forever).
      return new Promise<SteamUser>((resolve, reject) => {
        const handler = (u: SteamUser | null) => {
          if (u !== null) {
            userChangeListeners.delete(handler);
            userAsyncPending.delete(entry);
            resolve(u);
          }
        };
        const entry = { resolve, reject, handler };
        userAsyncPending.add(entry);
        userChangeListeners.add(handler);
      });
    },

    async getStoreCountry(): Promise<string | undefined> {
      try {
        if (!bridge) return undefined;
        const steamId = await resolveCurrentSteamId();
        if (!steamId) return undefined;
        const r = await bridge.call<{ country: string | null }>('get_store_country', { steamId });
        return typeof r?.country === 'string' ? r.country : undefined;
      } catch {
        return undefined;
      }
    },

    getMachineId(): Promise<MachineId | undefined> {
      return callRelayGetMachineId();
    },
  };
}
