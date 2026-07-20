import type { OwnedGame } from '../api/api-types';

interface RawApp {
  appid: number; display_name?: string; app_type?: number;
  minutes_playtime_forever?: number; minutes_playtime_last_two_weeks?: number;
  rt_purchased_time?: number; rt_steam_release_date?: number;
  rt_last_time_played?: number; metacritic_score?: number; size_on_disk?: number | string;
  /** Set only when the copy belongs to ANOTHER account (Family Sharing). */
  owner_account_id?: number | string;
}

// Steam's own AppOverview predicates, verified against the live client:
//   BIsOwned()    { return this.visible_in_game_list && this.subscribed_to }
//   BIsBorrowed() { return this.BIsOwned() && !!this.owner_account_id }
// allGamesCollection answers "what can I launch", which includes games borrowed
// from a family group — counting those inflated both library size and value.
// Numeric compare, NOT `!!` — owner_account_id comes off an untyped Steam
// global. If Steam ever serialized it as a string, `!!"0"` is true and the
// filter would drop the ENTIRE library while still reporting ready:true.
const isBorrowed = (a: RawApp): boolean => Number(a.owner_account_id) > 0;

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

/** Wait (bounded) for collectionStore to populate, then map to OwnedGame[],
 *  excluding games borrowed via Family Sharing. ready=false if the collection
 *  never populated within waitMs. Never throws.
 *  `familySharedExcluded` is the count dropped — it distinguishes "small
 *  library" from "most of the library belongs to a family member". */
export async function readOwnedGames(
  waitMs = 3000,
): Promise<{ games: OwnedGame[]; ready: boolean; familySharedExcluded: number }> {
  let apps = getCollectionApps();
  const start = Date.now();
  while ((!apps || apps.length === 0) && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
    apps = getCollectionApps();
  }
  // A collection that EXISTS but stayed empty for the whole wait is not a
  // credible "zero games" — that is what a Family View lock and a cold store
  // both look like. Report it as not-ready so the backend refuses to score it.
  if (!apps || apps.length === 0) return { games: [], ready: false, familySharedExcluded: 0 };
  const owned = apps.filter((a) => !isBorrowed(a));
  return { games: owned.map(mapApp), ready: true, familySharedExcluded: apps.length - owned.length };
}
