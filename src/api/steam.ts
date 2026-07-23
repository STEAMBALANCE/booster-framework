import type { SteamApi, SteamUser, MachineId, OwnedGamesResult, AppContext, InventoryResult, ParentalState } from './api-types';
import type { Registry } from '../registry';
import type { Bridge } from '../bridge';
import { createRelayChannel } from '../relay/channel';
import { deriveCurrency, parseBalanceNumber } from '../steam-internals/currency-map';
import { currencyForStoreCountry } from '../steam-internals/country-to-currency';
import { readCurrentSteamId64FromStoreGlobal, steamId64ToAccountId } from '../steam-internals/steam-id';
import { DEFAULT_INVENTORY_APPS } from '../steam-internals/inventory';

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

/** Inventory needs its own, much larger budget: one call walks 5 partitions
 *  SEQUENTIALLY, each paginating with get_descriptions over thousands of items.
 *  The shared 5s budget expired mid-walk on exactly the accounts that have the
 *  most to report, and the relay result — which does arrive — was discarded.
 *  Stays under the native 40s CDP deadline on host.getRateAccountData. */
export function getInventoryTimeoutMs(): number {
  if (typeof process === 'undefined') return 25000;
  const env = Number(process.env['SB_INVENTORY_RELAY_TIMEOUT_MS']);
  return Number.isFinite(env) && env > 0 ? env : 25000;
}

// Bounded wait for the first user-snapshot when resolving steamId for
// getStoreCountry from a cold context. Short — getStoreCountry is best-effort.
// Read at call-time (env override) so the rollback test can shorten it.
function getStoreCountrySteamIdWaitMs(): number {
  if (typeof process === 'undefined') return 3000;
  const env = Number(process.env['SB_STORE_COUNTRY_STEAMID_WAIT_MS']);
  return Number.isFinite(env) && env > 0 ? env : 3000;
}


// Basic URL safety gate (NOT a host allow-list). The legitimate redirect
// flow goes:
//   booster-checkout → /api/balance/add (steambalance.cc) → JSON {redirectUrl: ...}
//   → openUrl(redirectUrl) → MainWindowBrowserManager.LoadURL
// where redirectUrl points at a payment processor (Tinkoff / СБП / etc.) —
// host known only at runtime. The previous host allow-list (steambalance.cc
// only) blocked every real payment redirect with `host not allowed: <safeHost>`,
// which surfaced to the user as "Pay button does nothing" (popup just
// console.error-ed and reset). The reference implementation
// (C:/Users/Matrix/Desktop/sb_booster-main/scripts/popup_manager_native.js)
// calls LoadURL on whatever URL the popup posts, with no validation at all.
//
// Trust model: redirectUrl originates from steambalance.cc's own API
// response (HTTPS-fetched by the popup). The framework does NOT receive
// arbitrary URLs from untrusted sources. We do reject obvious
// foot-gun URL shapes (non-https, credential injection via userinfo,
// non-standard ports) since those have no legitimate use in a payment
// redirect and would either fail in CEF or carry exfil risk.
//
// Exported for unit testing — internal helper, not part of the public SbApi.
/** @internal */
export function isUrlSafeForNavigation(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  // No userinfo: `https://attacker:pass@example.com/x` parses with
  // host=example.com but routes credentials. Reject.
  if (parsed.username !== '' || parsed.password !== '') return false;
  // Empty port → default 443 only. Reject explicit ports (8080, 8443, etc).
  if (parsed.port !== '') return false;
  return true;
}

// Hostname-only for error messages — never includes port or query string,
// so it's safe to log even if the input URL carries a session token in
// userinfo or query (isHostAllowed already rejects such URLs, but safety
// is layered).
function safeHostForLog(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '<malformed>';
  }
}

interface SnapshotPayload {
  accountName: string;
  personaName?: string;
  steamId?: string;
  balanceFormatted?: string;
  isLimited?: boolean;
  isOfflineMode?: boolean;
}

export function makeSteamApi(registry: Registry, bridge: Bridge, relaySecret?: string): SteamApi {
  // Authenticated relay channel: outbound posts carry the per-launch secret;
  // inbound (user-snapshot, *-ok responses) lacking the tag are dropped —
  // closing the V3 forged-`user-snapshot` vector. `relaySecret === undefined`
  // (tests / pre-secret injector) ⇒ untagged passthrough.
  const ch = createRelayChannel(relaySecret);
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

  // Generic relay round-trip: post {kind:reqKind, requestId, ...payload}, await a
  // {kind:okKind, requestId} reply, resolve pick(reply) or `fallback` on timeout.
  // Uses the userExtraNextRequestId id-space + a fresh self-removing listener
  // (NOT the openUrl `pending` map). Never rejects.
  function callRelay<T>(reqKind: string, payload: object, okKind: string, pick: (m: any) => T, fallback: T, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve) => {
      const requestId = userExtraNextRequestId++;
      const timer = setTimeout(() => { off(); resolve(fallback); }, timeoutMs ?? getUserExtraTimeoutMs());
      const off = ch.onMessage((data) => {
        const m = data as { kind?: string; requestId?: number } | undefined;
        if (m?.kind !== okKind || m?.requestId !== requestId) return;
        clearTimeout(timer);
        off();
        resolve(pick(m));
      });
      ch.post({ kind: reqKind, requestId, ...payload });
    });
  }

  function callRelayGetAccountSettings(): Promise<{ email?: string; emailValidated?: boolean }> {
    return callRelay<{ email?: string; emailValidated?: boolean }>('get-user-account-settings', {}, 'user-account-settings-ok',
      (m) => ({ email: m.email, emailValidated: m.emailValidated }), {});
  }

  function callRelayGetCountry(): Promise<string | undefined> {
    return callRelay('get-user-country', {}, 'user-country-ok', (m) => m.value as string | undefined, undefined);
  }

  function callRelayGetLanguage(): Promise<string | undefined> {
    return callRelay('get-user-language', {}, 'user-language-ok', (m) => m.value as string | undefined, undefined);
  }

  function callRelayGetMachineId(): Promise<MachineId | undefined> {
    return callRelay('get-machine-id', {}, 'machine-id-ok', (m) => m.value as MachineId | undefined, undefined);
  }

  function makeSteamUserFromSnapshot(s: SnapshotPayload, currencyOverride?: string): SteamUser {
    const balanceFormatted = s.balanceFormatted;
    const currency = currencyOverride ?? (balanceFormatted ? deriveCurrency(balanceFormatted) : undefined);
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
      accountId:      steamId64ToAccountId(s.steamId),
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
      try { ch.close(); } catch { /* */ }
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

  ch.onMessage((data) => {
    const msg = data as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object') return;

    // Push path: relay sent a user-snapshot (cold-start handshake reply or
    // proactive push on user change). Build SteamUser and notify listeners.
    if (msg['kind'] === 'user-snapshot') {
      const snap = msg['snapshot'] as SnapshotPayload | undefined;
      if (!snap || typeof snap.accountName !== 'string') return;
      cachedUser = makeSteamUserFromSnapshot(snap);
      const built = cachedUser;
      notifyUserChange();
      // Fill currency for zero-balance wallets from the store country, then
      // re-fire (see healCurrencyFromCountry).
      if (!cachedUser.currency) void healCurrencyFromCountry(snap, built);
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
  ch.post({ kind: 'request-snapshot' });

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

  // Store-country read (native cache via bridge). Shared by getStoreCountry
  // (polls for a steamId from a cold context) and the currency self-heal
  // (passes the snapshot's steamId directly — no poll). Never throws.
  async function fetchStoreCountry(steamIdOverride?: string): Promise<string | undefined> {
    try {
      if (!bridge) return undefined;
      const steamId = steamIdOverride ?? await resolveCurrentSteamId();
      if (!steamId) return undefined;
      const r = await bridge.call<{ country: string | null }>('get_store_country', { steamId });
      return typeof r?.country === 'string' ? r.country : undefined;
    } catch {
      return undefined;
    }
  }

  // Notify all onUserChange subscribers of the current cachedUser.
  function notifyUserChange(): void {
    for (const cb of userChangeListeners) {
      try { cb(cachedUser); } catch { /* swallow */ }
    }
  }

  // Self-heal: a zero-balance wallet emits an empty balance string, so
  // deriveCurrency yields undefined. Fall back to the store country's currency
  // (single source of truth stays SteamUser.currency) and re-fire so every
  // downstream consumer (log, rate-account, checkout popup + addfunds via the
  // bus) corrects automatically. Reads store country by snap.steamId directly
  // (the store-country native cache is keyed by steamId — no steamId, nothing
  // to look up, so skip and avoid the resolveCurrentSteamId 3s poll). Guarded
  // against the account-switch race and a newer funded snapshot arriving
  // mid-await.
  async function healCurrencyFromCountry(snap: SnapshotPayload, built: SteamUser): Promise<void> {
    if (!snap.steamId) return;
    const currency = currencyForStoreCountry(await fetchStoreCountry(snap.steamId));
    if (!currency) return;
    // Apply only if no newer snapshot has replaced the instance we healed from
    // (covers account-switch AND a newer same-account snapshot) — reference
    // identity subsumes the field-level guards.
    if (cachedUser !== built) return;
    cachedUser = makeSteamUserFromSnapshot(snap, currency);
    notifyUserChange();
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
        ch.post({ kind: 'navigate', requestId, url });
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

    async getCurrentUserAsync(timeoutMs?: number): Promise<SteamUser> {
      if (cachedUser) return cachedUser;
      // Wait for the first non-null snapshot, tracked in userAsyncPending so
      // rollback can reject it. `timeoutMs` exists so callers don't race this
      // externally: a race ABANDONS the loser without unregistering, leaving a
      // handler that fires on every later snapshot for the session's life.
      return new Promise<SteamUser>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          userChangeListeners.delete(handler);
          userAsyncPending.delete(entry);
          if (timer !== undefined) clearTimeout(timer);
        };
        const handler = (u: SteamUser | null) => {
          if (u !== null) { cleanup(); resolve(u); }
        };
        const entry = { resolve, reject: (e: Error) => { cleanup(); reject(e); }, handler };
        userAsyncPending.add(entry);
        userChangeListeners.add(handler);
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timer = setTimeout(() => {
            cleanup();
            reject(new Error(`user-wait-timeout: no Steam user snapshot within ${timeoutMs}ms`));
          }, timeoutMs);
        }
      });
    },

    getStoreCountry(): Promise<string | undefined> {
      return fetchStoreCountry();
    },

    async getStoreCurrency(): Promise<string | undefined> {
      // 1. Real wallet currency from the balance string (funded wallet; also the
      //    value the snapshot self-heal fills in for returning users).
      if (cachedUser?.currency) return cachedUser.currency;
      // 2. Fallback from the store country, read LIVE each call — so it resolves
      //    mid-session the moment a store visit has captured the country, even
      //    when no new snapshot has re-fired the reactive self-heal (new users).
      return currencyForStoreCountry(await fetchStoreCountry());
    },

    getMachineId(): Promise<MachineId | undefined> {
      return callRelayGetMachineId();
    },

    getOwnedGames(options?: { includePrices?: boolean }): Promise<OwnedGamesResult> {
      return callRelay('get-owned-games', { includePrices: !!options?.includePrices },
        'owned-games-ok', (m) => m.result as OwnedGamesResult,
        { games: [], pricesIncluded: !!options?.includePrices, ready: false });
    },

    getInventory(options?: { apps?: AppContext[]; maxItemsPerApp?: number; includeIcons?: boolean }): Promise<InventoryResult> {
      // Relay round-trip: the SharedJSContext handler calls fetchInventory over
      // the authenticated CM and posts back `inventory-ok`. Never rejects —
      // resolves the empty/partial default on timeout.
      // Fallback mirrors the relay's per-app rows: a bare `perApp: []` reads as
      // "no partitions requested" and hides that the walk timed out.
      const apps = options?.apps ?? DEFAULT_INVENTORY_APPS;
      return callRelay('get-inventory',
        { options: options ?? {} },
        'inventory-ok', (m) => m.result as InventoryResult,
        { items: [],
          perApp: apps.map((a) => ({ ...a, fetched: 0, ok: false, error: 'relay timeout' })),
          partial: true },
        getInventoryTimeoutMs());
    },

    getAccountLevel(): Promise<number | undefined> {
      const accountId = cachedUser?.accountId;
      return callRelay('get-account-level', { accountId }, 'account-level-ok',
        (m) => m.level as number | undefined, undefined);
    },

    getParentalState(): Promise<ParentalState | undefined> {
      return callRelay('get-parental-state', {}, 'parental-state-ok',
        (m) => m.state as ParentalState | undefined, undefined);
    },

    async getAvatarDataUrl(): Promise<string | null> {
      const steamId = await resolveCurrentSteamId();
      if (!steamId) return null;
      return callRelay('get-avatar', { steamId }, 'avatar-ok',
        (m) => (typeof m.dataUrl === 'string' ? m.dataUrl : null), null);
    },
  };
}
