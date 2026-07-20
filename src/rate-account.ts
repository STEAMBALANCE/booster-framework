import type { SbApi, OwnedGame, InventoryItem, InventoryAppResult, ParentalState } from './api/api-types';

// Payload builder for the rate-account flow. The WIRE shape is snake_case per
// the backend contract; we explicitly remap the framework's camelCase
// SteamUser / OwnedGame / InventoryItem fields (api-types.ts) — no blind cast.
// Game prices are flattened to two minor-unit hint fields (price / original_price);
// the backend is authoritative for pricing.

export interface RateGame {
  appid: number;
  name: string;
  app_type: number;
  playtime_forever_minutes: number;
  playtime_two_weeks_minutes?: number;
  purchased_at?: number;
  release_at?: number;
  last_played_at?: number;
  metacritic?: number;
  size_on_disk_bytes?: number;
  price: number | null;           // final (current) price, minor units — hint
  original_price: number | null;  // pre-discount price, minor units — hint
}
export interface RateItem {
  appid: number;
  contextid: string;
  assetid: string;
  classid: string;
  instanceid: string;
  amount: number;
  market_hash_name?: string;
  market_name?: string;
  name?: string;
  type?: string;
  marketable: boolean;
  tradable: boolean;
  market_fee_app?: number;
}
export interface RatePerApp {
  appid: number;
  contextid: string;
  total_count?: number;
  fetched: number;
  ok: boolean;
  error?: string;
}
export interface RatePayload {
  captured_at: number;
  account: {
    username: string;
    persona_name: string | null;
    // Small JPEG data URI (downscaled ~128px) for direct <img> display, or null.
    avatar: string | null;
    email: string | null;
    email_validated: boolean | null;
    steam_id: string | null;
    account_id: number | null;
    level: number | null;
    country: string | null;
    currency: string | null;
    // major-units decimal parsed from the localized string (e.g. 17181.65),
    // NOT minor units. wallet_balance_formatted carries the display form.
    wallet_balance: number | null;
    wallet_balance_formatted: string | null;
    is_limited: boolean;
    /** Steam Family View state at capture time. null = could not be determined
     *  (never true when the payload exists — a locked run rejects instead). */
    family_view_locked: boolean | null;
  };
  library: {
    currency: string | null;
    /** false = the library never loaded (relay timeout, Family View lock, …).
     *  An empty games[] with ready:true is a genuinely empty account; with
     *  ready:false it means "we could not read it" — do NOT treat as zero. */
    ready: boolean;
    /** Games excluded because they are borrowed from a family group. */
    family_shared_excluded: number;
    games: RateGame[];
  };
  inventory: {
    partial: boolean;
    item_count: number;
    per_app: RatePerApp[];
    items: RateItem[];
  };
}

const n = <T>(v: T | undefined | null): T | null => (v === undefined || v === null ? null : v);

/** Machine-readable prefix on the rejection when no Steam user snapshot ever
 *  arrives. Surfaces to the page as the `error` string of the bridge reply. */
export const RATE_ERR_USER_UNAVAILABLE = 'sb_user_unavailable';

/** Rejection prefix when Steam Family View is active: the library and inventory
 *  stores are PIN-gated, so collecting would yield a confident-looking zero. */
export const RATE_ERR_FAMILY_VIEW_LOCKED = 'sb_family_view_locked';

/** Rejection prefix when the whole collection outruns its budget. */
export const RATE_ERR_COLLECTION_TIMEOUT = 'sb_collection_timeout';

/** ONE wall-clock budget for the entire collection, not per-phase constants.
 *  The phases run sequentially (user → parental → fan-out), so independent
 *  budgets would ADD UP: 20+5+25 exceeded the native 40s CDP deadline on
 *  host.getRateAccountData, and blowing that deadline discards the payload
 *  whole — including the error codes this collector exists to report. 35s
 *  leaves head-room for the native round-trip itself. */
export function getCollectionBudgetMs(): number {
  if (typeof process === 'undefined') return 35000;
  const env = Number(process.env['SB_RATE_BUDGET_MS']);
  return Number.isFinite(env) && env > 0 ? env : 35000;
}

/** Race `p` against the time left on the shared deadline. Rejects with `code`
 *  when the budget is gone; the loser is abandoned, never cancelled. */
async function withinBudget<T>(p: Promise<T>, deadline: number, code: string, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const left = Math.max(0, deadline - Date.now());
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${code}: ${what} (budget spent after ${getCollectionBudgetMs()}ms)`)), left);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mapGame(g: OwnedGame): RateGame {
  return {
    appid: g.appid,
    name: g.name,
    app_type: g.appType,
    playtime_forever_minutes: g.playtimeForeverMinutes,
    playtime_two_weeks_minutes: g.playtimeTwoWeeksMinutes,
    purchased_at: g.purchasedAt,
    release_at: g.releaseAt,
    last_played_at: g.lastPlayedAt,
    metacritic: g.metacritic,
    size_on_disk_bytes: g.sizeOnDiskBytes,
    price: g.price?.finalMinor ?? null,
    original_price: g.price?.originalMinor ?? null,
  };
}

function mapItem(it: InventoryItem): RateItem {
  return {
    appid: it.appid,
    contextid: it.contextid,
    assetid: it.assetid,
    classid: it.classid,
    instanceid: it.instanceid,
    amount: it.amount,
    market_hash_name: it.marketHashName,
    market_name: it.marketName,
    name: it.name,
    type: it.type,
    marketable: it.marketable,
    tradable: it.tradable,
    market_fee_app: it.marketFeeApp,
  };
}

function mapPerApp(a: InventoryAppResult): RatePerApp {
  return {
    appid: a.appid,
    contextid: a.contextid,
    total_count: a.totalCount,
    fetched: a.fetched,
    ok: a.ok,
    error: a.error,
  };
}

export async function collectRatePayload(sb: SbApi, now: number): Promise<RatePayload> {
  const deadline = Date.now() + getCollectionBudgetMs();

  // Belt AND braces. The bound passed IN lets getCurrentUserAsync unregister
  // its listener (a plain race abandons the loser still subscribed, leaking a
  // handler per retry). The outer budget still applies, because an
  // implementation that ignores the argument would otherwise hang forever.
  let user;
  try {
    user = await withinBudget(
      sb.steam.getCurrentUserAsync(Math.max(1, deadline - Date.now())),
      deadline, RATE_ERR_USER_UNAVAILABLE,
      'no Steam user snapshot (signed out, or Family View lock)');
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!msg.includes('user-wait-timeout')) throw e;  // rollback / budget code propagate as-is
    throw new Error(`${RATE_ERR_USER_UNAVAILABLE}: no Steam user snapshot (signed out, or Family View lock)`);
  }

  // Parental state joins the fan-out rather than serializing ahead of it — the
  // gate is about not TRUSTING the data, not about not fetching it in parallel.
  const parentalP: Promise<ParentalState | undefined> =
    typeof sb.steam.getParentalState === 'function'
      ? sb.steam.getParentalState()
      : Promise.resolve(undefined);

  const [parental, email, emailValidated, country, level, owned, inv, avatar] = await withinBudget(
    Promise.all([
      parentalP,
      user.email(), user.emailValidated(), sb.steam.getStoreCountry(),
      sb.steam.getAccountLevel(), sb.steam.getOwnedGames({ includePrices: true }), sb.steam.getInventory(),
      sb.steam.getAvatarDataUrl(),
    ]),
    deadline, RATE_ERR_COLLECTION_TIMEOUT, 'collection did not finish');

  // `undefined` means UNKNOWN (older client, relay unreachable) — proceed, but
  // report it as null rather than claiming the account is unlocked.
  if (parental?.locked) {
    throw new Error(`${RATE_ERR_FAMILY_VIEW_LOCKED}: Steam Family View is active — unlock it with the PIN and retry`);
  }

  return {
    captured_at: now,
    account: {
      username: user.accountName,
      persona_name: n(user.personaName),
      avatar: n(avatar),
      email: n(email),
      email_validated: n(emailValidated),
      steam_id: n(user.steamId),
      account_id: n(user.accountId),
      level: n(level),
      country: n(country),
      currency: n(user.currency),
      wallet_balance: n(user.balance),
      wallet_balance_formatted: n(user.balanceFormatted),
      is_limited: !!user.isLimited,
      family_view_locked: parental ? parental.locked : null,
    },
    library: {
      currency: n(owned.currency),
      ready: owned.ready !== false,
      family_shared_excluded: owned.familySharedExcluded ?? 0,
      games: owned.games.map(mapGame),
    },
    inventory: {
      partial: inv.partial,
      item_count: inv.items.length,
      per_app: inv.perApp.map(mapPerApp),
      items: inv.items.map(mapItem),
    },
  };
}
