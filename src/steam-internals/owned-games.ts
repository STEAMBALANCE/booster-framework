import type { OwnedGame } from '../api/api-types';

interface RawApp {
  appid: number; display_name?: string; app_type?: number;
  minutes_playtime_forever?: number; minutes_playtime_last_two_weeks?: number;
  rt_purchased_time?: number; rt_steam_release_date?: number;
  rt_last_time_played?: number; metacritic_score?: number; size_on_disk?: number | string;
}

function getCollectionApps(): RawApp[] | undefined {
  const w = typeof window !== 'undefined' ? window : undefined;
  const cs = (w as unknown as { collectionStore?: { allGamesCollection?: { allApps?: unknown } } } | undefined)?.collectionStore;
  const all = cs?.allGamesCollection?.allApps;
  return Array.isArray(all) ? (all as RawApp[]) : undefined;
}

function mapApp(a: RawApp): OwnedGame {
  const rawSize = typeof a.size_on_disk === 'string' ? Number(a.size_on_disk) : a.size_on_disk;
  const size = Number.isFinite(rawSize) && rawSize ? (rawSize as number) : undefined;
  return {
    appid: a.appid,
    name: a.display_name ?? '',
    appType: a.app_type ?? 0,
    playtimeForeverMinutes: a.minutes_playtime_forever ?? 0,
    playtimeTwoWeeksMinutes: a.minutes_playtime_last_two_weeks || undefined,
    purchasedAt: a.rt_purchased_time || undefined,
    releaseAt: a.rt_steam_release_date || undefined,
    lastPlayedAt: a.rt_last_time_played || undefined,
    metacritic: a.metacritic_score || undefined,
    sizeOnDiskBytes: size,
  };
}

/** Wait (bounded) for collectionStore to populate, then map to OwnedGame[].
 *  ready=false if the collection never populated within waitMs. Never throws. */
export async function readOwnedGames(waitMs = 3000): Promise<{ games: OwnedGame[]; ready: boolean }> {
  let apps = getCollectionApps();
  const start = Date.now();
  while ((!apps || apps.length === 0) && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
    apps = getCollectionApps();
  }
  if (!apps) return { games: [], ready: false };
  return { games: apps.map(mapApp), ready: true };
}
