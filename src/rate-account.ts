import type { SbApi, OwnedGame, InventoryItem, InventoryAppResult } from './api/api-types';

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
  };
  library: {
    currency: string | null;
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
  const user = await sb.steam.getCurrentUserAsync();

  const [email, emailValidated, country, level, owned, inv] = await Promise.all([
    user.email(), user.emailValidated(), sb.steam.getStoreCountry(),
    sb.steam.getAccountLevel(), sb.steam.getOwnedGames({ includePrices: true }), sb.steam.getInventory(),
  ]);

  return {
    captured_at: now,
    account: {
      username: user.accountName,
      persona_name: n(user.personaName),
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
    },
    library: {
      currency: n(owned.currency),
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
