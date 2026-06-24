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

/** Read the logged-in user's SteamID64 from the store page's `g_AccountID`
 *  global (present on store.steampowered.com contexts). undefined elsewhere. */
export function readCurrentSteamId64FromStoreGlobal(): string | undefined {
  const acc = (globalThis as { g_AccountID?: unknown }).g_AccountID;
  return accountIdToSteamId64(typeof acc === 'number' || typeof acc === 'string' ? acc : undefined);
}
