import { resolveModuleByContent, pickExport } from './webpack-modules';
import { nativeWarn } from '../native-warn';

const PLAYER_ROUTE = 'Player.GetGameBadgeLevels#1';

export interface LevelDeps {
  cmLevel: () => Promise<number | undefined>;
  miniprofileLevel: (accountId: number | undefined) => Promise<number | undefined>;
}

/** Pure, dependency-injected core (unit-tested). CM first, miniprofile fallback. */
export async function fetchAccountLevelWithDeps(
  accountId: number | undefined,
  deps: LevelDeps,
): Promise<number | undefined> {
  try { const lvl = await deps.cmLevel(); if (typeof lvl === 'number') return lvl; } catch { /* fall through */ }
  try { const lvl = await deps.miniprofileLevel(accountId); if (typeof lvl === 'number') return lvl; } catch { /* fall through */ }
  nativeWarn('[sb] account-level: CM and miniprofile both unavailable');
  return undefined;
}

function getTransport(): unknown | undefined {
  const cm = (window as any).g_FriendsUIApp?.CMInterface;
  try { return typeof cm?.GetServiceTransport === 'function' ? cm.GetServiceTransport() : undefined; } catch { return undefined; }
}

async function cmLevel(): Promise<number | undefined> {
  const mod = resolveModuleByContent(PLAYER_ROUTE);
  const stub = pickExport(mod, (v) => !!v && typeof (v as any).GetGameBadgeLevels === 'function') as any;
  const transport = getTransport();
  if (!stub || !transport) return undefined;
  try {
    const resp = await stub.GetGameBadgeLevels(transport, {});
    if (resp?.GetEResult?.() !== 1) return undefined;
    const lvl = resp.Body().toObject().player_level;
    return typeof lvl === 'number' ? lvl : undefined;
  } catch { return undefined; }
}

async function miniprofileLevel(accountId: number | undefined): Promise<number | undefined> {
  if (!accountId) return undefined;
  // Steam's internal authenticated axios client (steam-chat.com is CORS-allowed
  // for steamloopback.host, unlike steamcommunity.com).
  const sar = (window as any).steamAjaxRequest;
  if (sar && typeof sar.get === 'function') {
    try {
      const origin = (globalThis as any).location?.origin ?? 'https://steamloopback.host';
      const url = `https://steam-chat.com/miniprofile/${accountId}/json/?origin=${encodeURIComponent(origin)}`;
      const resp = await sar.get(url, { retrycount: 1, retrydelayMS: 800 });
      const data = (resp && (resp.data ?? resp)) as { level?: number };
      if (typeof data?.level === 'number') return data.level;
    } catch { /* fall through */ }
  }
  return undefined;
}

/** Production entry. */
export function fetchAccountLevel(accountId: number | undefined): Promise<number | undefined> {
  return fetchAccountLevelWithDeps(accountId, { cmLevel, miniprofileLevel });
}
