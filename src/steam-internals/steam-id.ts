// SteamID64 (individual/public) = base + 32-bit accountID. Base verified live
// against RegisterForCurrentUserChanges.strSteamID (derived === snapshot).
const STEAMID64_INDIVIDUAL_BASE = 76561197960265728n;

/** Convert a 32-bit Steam accountID (e.g. store-page `g_AccountID`) to a full
 *  SteamID64 decimal string. Returns undefined for absent / non-positive /
 *  unparseable input. */
export function accountIdToSteamId64(accountId: number | string | undefined): string | undefined {
  if (accountId === undefined || accountId === null) return undefined;
  let n: bigint;
  try { n = BigInt(accountId); } catch { return undefined; }
  if (n <= 0n) return undefined;
  return (STEAMID64_INDIVIDUAL_BASE + n).toString();
}

/** Convert a full SteamID64 decimal string to its 32-bit accountID. Inverse of
 *  accountIdToSteamId64. Returns undefined for absent / unparseable / at-or-below
 *  base / out-of-range input. BigInt avoids the Number() precision loss on the
 *  ~17-digit id. */
export function steamId64ToAccountId(steamId64: string | undefined): number | undefined {
  if (!steamId64) return undefined;
  let n: bigint;
  try { n = BigInt(steamId64); } catch { return undefined; }
  const acc = n - STEAMID64_INDIVIDUAL_BASE;
  if (acc <= 0n || acc > 0xffffffffn) return undefined;
  return Number(acc);
}

/** Read the logged-in user's SteamID64 from the store page's `g_AccountID`
 *  global (present on store.steampowered.com contexts). undefined elsewhere. */
export function readCurrentSteamId64FromStoreGlobal(): string | undefined {
  const acc = (globalThis as { g_AccountID?: unknown }).g_AccountID;
  return accountIdToSteamId64(typeof acc === 'number' || typeof acc === 'string' ? acc : undefined);
}
