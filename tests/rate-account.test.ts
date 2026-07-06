import { describe, it, expect } from 'bun:test';
import { collectRatePayload } from '../src/rate-account';

function fakeSb(over: any = {}): any {
  const user = {
    accountName: 'login', personaName: 'Matrix', steamId: '765611980', accountId: 42,
    currency: 'KZT', balance: 1718165, balanceFormatted: '17 181,65₸', isLimited: false,
    email: async () => 'a@b.co', emailValidated: async () => true, ...over.user,
  };
  return { steam: {
    getCurrentUserAsync: async () => user,
    getStoreCountry: async () => 'RU',
    getAccountLevel: async () => 42,
    getOwnedGames: async () => ({ games: [{ appid: 730, name: 'CS2', appType: 1, playtimeForeverMinutes: 10, purchasedAt: 1500, price: { isFree: false, finalMinor: 24900, originalMinor: 99900, discountPct: 75 } }], pricesIncluded: true, currency: 'KZT', ready: true }),
    getInventory: async () => ({ items: [{ appid: 730, contextid: '2', assetid: '1', classid: '1', instanceid: '0', amount: 1, marketHashName: 'AK', marketName: 'AK-47', marketFeeApp: 730, marketable: true, tradable: true }], perApp: [{ appid: 730, contextid: '2', fetched: 1, ok: true }], partial: false }),
    ...over.steam,
  } };
}

describe('collectRatePayload', () => {
  it('maps a full snapshot to the snake_case wire shape', async () => {
    const p = await collectRatePayload(fakeSb(), 1751800000000);
    expect(p.captured_at).toBe(1751800000000);
    // account (snake_case)
    expect(p.account.username).toBe('login');
    expect(p.account.persona_name).toBe('Matrix');
    expect(p.account.email).toBe('a@b.co');
    expect(p.account.email_validated).toBe(true);
    expect(p.account.steam_id).toBe('765611980');
    expect(p.account.account_id).toBe(42);
    expect(p.account.wallet_balance).toBe(1718165);   // fake feeds an int; real value is major-units decimal
    expect(p.account.wallet_balance_formatted).toBe('17 181,65₸');
    expect(p.account.is_limited).toBe(false);
    // library (no ready/pricesIncluded/gameCount)
    expect(p.library.currency).toBe('KZT');
    expect(p.library.games[0].appid).toBe(730);
    expect(p.library.games[0].app_type).toBe(1);
    expect(p.library.games[0].playtime_forever_minutes).toBe(10);
    expect(p.library.games[0].purchased_at).toBe(1500);
    // price flattened to two minor-unit fields
    expect(p.library.games[0].price).toBe(24900);
    expect(p.library.games[0].original_price).toBe(99900);
    // inventory (snake_case)
    expect(p.inventory.item_count).toBe(1);
    expect(p.inventory.items[0].market_hash_name).toBe('AK');
    expect(p.inventory.items[0].market_name).toBe('AK-47');
    expect(p.inventory.items[0].market_fee_app).toBe(730);
    expect(p.inventory.per_app[0].ok).toBe(true);
  });

  it('drops the removed fields (schemaVersion / library ready / pricesIncluded / gameCount)', async () => {
    const p: any = await collectRatePayload(fakeSb(), 1);
    expect('schemaVersion' in p).toBe(false);
    expect('capturedAt' in p).toBe(false);
    expect('ready' in p.library).toBe(false);
    expect('pricesIncluded' in p.library).toBe(false);
    expect('gameCount' in p.library).toBe(false);
    // price is a flat number, not an object
    expect(typeof p.library.games[0].price).toBe('number');
  });

  it('flattens a missing price to null / null', async () => {
    const sb = fakeSb();
    sb.steam.getOwnedGames = async () => ({ games: [{ appid: 570, name: 'Dota', appType: 1, playtimeForeverMinutes: 0 }], pricesIncluded: true, currency: 'KZT', ready: true });
    const p = await collectRatePayload(sb, 1);
    expect(p.library.games[0].price).toBeNull();
    expect(p.library.games[0].original_price).toBeNull();
  });

  it('propagates a getCurrentUserAsync rejection (e.g. framework rollback)', async () => {
    const sb = fakeSb(); sb.steam.getCurrentUserAsync = async () => { throw new Error('framework rolled back'); };
    await expect(collectRatePayload(sb, 1)).rejects.toThrow();
  });

  it('degrades: null email, empty library, partial:true', async () => {
    const sb = fakeSb();
    sb.steam.getCurrentUserAsync = async () => ({ accountName: 'l', personaName: 'p', steamId: null, accountId: null, currency: null, balance: null, balanceFormatted: null, isLimited: false, email: async () => undefined, emailValidated: async () => undefined });
    sb.steam.getStoreCountry = async () => undefined;
    sb.steam.getAccountLevel = async () => undefined;
    sb.steam.getOwnedGames = async () => ({ games: [], pricesIncluded: true, ready: false });
    sb.steam.getInventory = async () => ({ items: [], perApp: [], partial: true });
    const p = await collectRatePayload(sb, 1);
    expect(p.account.email).toBeNull();
    expect(p.account.level).toBeNull();
    expect(p.library.games).toEqual([]);
    expect(p.inventory.partial).toBe(true);
    expect(p.inventory.item_count).toBe(0);
  });
});
