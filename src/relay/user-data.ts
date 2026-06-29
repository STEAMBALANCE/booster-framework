import type { ScopeApi } from '../api/scope';
import type { RelayPoster } from './channel';
import { nativeWarn } from '../native-warn';
import { readPersonaNameSync } from '../steam-internals/app-globals';

declare const __SB_PRODUCTION__: boolean;

// UserChangeSnapshot inferred from RegisterForCurrentUserChanges parameter type.
// Lifted from existing shared-context.ts:199-201.
type RegisterFn = NonNullable<NonNullable<NonNullable<
  Window['SteamClient']
>['User']>['RegisterForCurrentUserChanges']>;
export type UserChangeSnapshot = NonNullable<Parameters<RegisterFn>[0]> extends (info: infer I) => unknown ? I : never;

export interface SnapshotPayload {
  accountName: string;
  personaName?: string;
  steamId?: string;
  balanceFormatted?: string;
  isLimited?: boolean;
  isOfflineMode?: boolean;
}

export const RELEVANT_FIELDS: Array<keyof UserChangeSnapshot> = [
  'strAccountName',
  'strSteamID',
  'strAccountBalance',
  'bIsLimited',
  'bIsOfflineMode',
];

let latestUserChange: UserChangeSnapshot | null = null;
let prevSnapshot: UserChangeSnapshot | null = null;
let prevPersonaName: string | undefined = undefined;
let listenerActive = false;

// ---------------------------------------------------------------------------
// Lazy enrichment caches — tri-state via MISS symbol so `undefined` cached is
// distinct from "never fetched".
// ---------------------------------------------------------------------------

const MISS = Symbol('cache-miss');

let cachedEmail:          string  | undefined | typeof MISS = MISS;
let cachedEmailValidated: boolean | undefined | typeof MISS = MISS;
let cachedIpCountry:      string  | undefined | typeof MISS = MISS;
let cachedLanguage:       string  | undefined | typeof MISS = MISS;

interface AccountSettingsInflight {
  promise: Promise<{ strEmail?: string; bEmailValidated?: boolean } | undefined>;
}
let inflightAccountSettings: AccountSettingsInflight | null = null;

interface CountryInflight { promise: Promise<string | undefined>; }
let inflightCountry: CountryInflight | null = null;

interface LanguageInflight { promise: Promise<string | undefined>; }
let inflightLanguage: LanguageInflight | null = null;

function clearLazyCaches(): void {
  // Do NOT null inflight refs here: inflight Promises keep running because
  // SteamClient calls cannot be cancelled. Race-resolution is handled at
  // write-time — accountName is rechecked and cache writes are gated on
  // === MISS, so a late resolver from the previous account can't poison
  // the current account's cache.
  cachedEmail = MISS;
  cachedEmailValidated = MISS;
  cachedIpCountry = MISS;
  cachedLanguage = MISS;
}

function isRelevantChange(
  prev: UserChangeSnapshot | null,
  next: UserChangeSnapshot,
  prevPersona: string | undefined,
  nextPersona: string | undefined,
): boolean {
  if (!prev) return true;
  for (const f of RELEVANT_FIELDS) if (prev[f] !== next[f]) return true;
  if (prevPersona !== nextPersona) return true;
  return false;
}

function buildSnapshotPayload(
  s: UserChangeSnapshot,
  personaName: string | undefined,
): SnapshotPayload {
  return {
    accountName:      s.strAccountName!,
    personaName,
    steamId:          s.strSteamID,
    balanceFormatted: s.strAccountBalance,
    isLimited:        s.bIsLimited,
    isOfflineMode:    s.bIsOfflineMode,
  };
}

/** Re-build snapshot for cold-start handshake (request-snapshot handler).
 *  Returns null if no callback has fired yet or if strAccountName is absent. */
export function buildSnapshotForHandshake(): SnapshotPayload | null {
  if (!latestUserChange) return null;
  if (typeof latestUserChange.strAccountName !== 'string') return null;
  return buildSnapshotPayload(latestUserChange, readPersonaNameSync());
}

/** Test-only reset. Module-level state survives across bun test runs
 *  because the module is cached. Tests MUST call this in beforeEach to
 *  start with a clean module. Production never calls this — the body is
 *  dead-code-eliminated by bun's `define` substitution of `__SB_PRODUCTION__`
 *  (see framework/build.ts:40 and src/index.ts:12). */
export function __resetForTests(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof __SB_PRODUCTION__ !== 'undefined' && __SB_PRODUCTION__) return;
  latestUserChange = null;
  prevSnapshot = null;
  prevPersonaName = undefined;
  listenerActive = false;
  cachedEmail = MISS;
  cachedEmailValidated = MISS;
  cachedIpCountry = MISS;
  cachedLanguage = MISS;
  inflightAccountSettings = null;
  inflightCountry = null;
  inflightLanguage = null;
}

export function installUserChangeListener(scope: ScopeApi, bc: RelayPoster): void {
  if (listenerActive) return;

  const sc = window.SteamClient;
  if (typeof sc?.User?.RegisterForCurrentUserChanges !== 'function') {
    nativeWarn('installUserChangeListener: RegisterForCurrentUserChanges absent');
    return;
  }

  let reg: { unregister: () => void } | undefined;
  try {
    reg = sc.User.RegisterForCurrentUserChanges((info) => {
      const next = info as UserChangeSnapshot;
      const nextPersona = readPersonaNameSync();

      if (typeof next.strAccountName !== 'string') {
        // Steam should always populate strAccountName on a real user-change.
        // Log and skip — don't broadcast a malformed snapshot.
        nativeWarn('user-change callback missing strAccountName, skipping');
        return;
      }

      // On the first callback, prevSnapshot is null → triggers a clear, but
      // caches are MISS already so this is a no-op. On account switches the
      // clear discards the previous account's enriched data.
      if (prevSnapshot?.strAccountName !== next.strAccountName) {
        clearLazyCaches();
      }

      // Set latestUserChange AFTER cache clear so in-flight handlers that read
      // latestUserChange?.strAccountName see either old OR new account, never
      // the new account with old caches. (JS is single-threaded, but ordering
      // hardens against future async refactors.)
      latestUserChange = next;

      if (isRelevantChange(prevSnapshot, next, prevPersonaName, nextPersona)) {
        bc.postMessage({
          kind: 'user-snapshot',
          snapshot: buildSnapshotPayload(next, nextPersona),
        });
      }
      prevSnapshot = next;
      prevPersonaName = nextPersona;
    });
  } catch (e) {
    nativeWarn('installUserChangeListener: register threw', { error: String(e) });
    return;
  }
  if (!reg) {
    nativeWarn('installUserChangeListener: register returned falsy');
  }
  listenerActive = true;

  scope.signal.addEventListener('abort', () => {
    try { reg?.unregister(); } catch {}
    listenerActive = false;
    latestUserChange = null;
    prevSnapshot = null;
    prevPersonaName = undefined;
    clearLazyCaches();
    // Inflight Steam calls cannot be cancelled — but null'ing the refs
    // means a re-injection's listener won't share the aborted scope's pending fetch.
    inflightAccountSettings = null;
    inflightCountry = null;
    inflightLanguage = null;
  }, { once: true });
}

/** Handle request-snapshot BC. Re-broadcasts the latest snapshot if any
 *  callback has fired; otherwise silent. Idempotent. */
export function handleRequestSnapshot(bc: RelayPoster): void {
  const snap = buildSnapshotForHandshake();
  if (snap) {
    bc.postMessage({ kind: 'user-snapshot', snapshot: snap });
  }
}

async function fetchAccountSettings(): Promise<{ strEmail?: string; bEmailValidated?: boolean } | undefined> {
  if (inflightAccountSettings) return inflightAccountSettings.promise;
  const promise = (async () => {
    const sc = window.SteamClient;
    if (typeof sc?.Settings?.GetAccountSettings !== 'function') return undefined;
    try { return await sc.Settings.GetAccountSettings(); }
    catch { return undefined; }
  })();
  inflightAccountSettings = { promise };
  const r = await promise;
  inflightAccountSettings = null;
  return r;
}

interface GetUserAccountSettingsRequest { kind: 'get-user-account-settings'; requestId: number; }

export async function handleGetUserAccountSettings(
  msg: GetUserAccountSettingsRequest,
  bc: RelayPoster,
): Promise<void> {
  if (cachedEmail !== MISS && cachedEmailValidated !== MISS) {
    bc.postMessage({
      kind: 'user-account-settings-ok',
      requestId: msg.requestId,
      email: cachedEmail,
      emailValidated: cachedEmailValidated,
    });
    return;
  }
  const accountAtRequest = latestUserChange?.strAccountName;
  const r = await fetchAccountSettings();
  if (latestUserChange?.strAccountName !== accountAtRequest) {
    // Account switched mid-fetch — caller gets undefined, NO cache write.
    bc.postMessage({
      kind: 'user-account-settings-ok',
      requestId: msg.requestId,
      email: undefined,
      emailValidated: undefined,
    });
    return;
  }
  const newEmail = typeof r?.strEmail === 'string' ? r.strEmail : undefined;
  const newValidated = typeof r?.bEmailValidated === 'boolean' ? r.bEmailValidated : undefined;
  if (cachedEmail === MISS)          cachedEmail = newEmail;
  if (cachedEmailValidated === MISS) cachedEmailValidated = newValidated;

  bc.postMessage({
    kind: 'user-account-settings-ok',
    requestId: msg.requestId,
    email: cachedEmail,
    emailValidated: cachedEmailValidated,
  });
}

interface GetUserCountryRequest { kind: 'get-user-country'; requestId: number; }
export async function handleGetUserCountry(msg: GetUserCountryRequest, bc: RelayPoster): Promise<void> {
  if (cachedIpCountry !== MISS) {
    bc.postMessage({ kind: 'user-country-ok', requestId: msg.requestId, value: cachedIpCountry });
    return;
  }
  if (!inflightCountry) {
    inflightCountry = {
      promise: (async () => {
        const sc = window.SteamClient;
        if (typeof sc?.User?.GetIPCountry !== 'function') return undefined;
        try { return await sc.User.GetIPCountry(); }
        catch { return undefined; }
      })(),
    };
  }
  const accountAtRequest = latestUserChange?.strAccountName;
  const v = await inflightCountry.promise;
  inflightCountry = null;
  if (latestUserChange?.strAccountName !== accountAtRequest) {
    bc.postMessage({ kind: 'user-country-ok', requestId: msg.requestId, value: undefined });
    return;
  }
  if (cachedIpCountry === MISS) cachedIpCountry = typeof v === 'string' ? v : undefined;
  bc.postMessage({ kind: 'user-country-ok', requestId: msg.requestId, value: cachedIpCountry });
}

interface GetUserLanguageRequest { kind: 'get-user-language'; requestId: number; }
export async function handleGetUserLanguage(msg: GetUserLanguageRequest, bc: RelayPoster): Promise<void> {
  if (cachedLanguage !== MISS) {
    bc.postMessage({ kind: 'user-language-ok', requestId: msg.requestId, value: cachedLanguage });
    return;
  }
  if (!inflightLanguage) {
    inflightLanguage = {
      promise: (async () => {
        const sc = window.SteamClient;
        if (typeof sc?.Settings?.GetCurrentLanguage !== 'function') return undefined;
        try { return await sc.Settings.GetCurrentLanguage(); }
        catch { return undefined; }
      })(),
    };
  }
  const accountAtRequest = latestUserChange?.strAccountName;
  const v = await inflightLanguage.promise;
  inflightLanguage = null;
  if (latestUserChange?.strAccountName !== accountAtRequest) {
    bc.postMessage({ kind: 'user-language-ok', requestId: msg.requestId, value: undefined });
    return;
  }
  if (cachedLanguage === MISS) cachedLanguage = typeof v === 'string' ? v : undefined;
  bc.postMessage({ kind: 'user-language-ok', requestId: msg.requestId, value: cachedLanguage });
}
