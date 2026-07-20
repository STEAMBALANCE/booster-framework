import { describe, it, expect } from 'bun:test';
import { collectRatePayload, getCollectionBudgetMs } from '../src/rate-account';

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
    getAvatarDataUrl: async () => 'data:image/jpeg;base64,QUJD',
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
    expect(p.account.avatar).toBe('data:image/jpeg;base64,QUJD');
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

  // `ready` was dropped from the wire shape when this collector was first
  // written, as redundant. It is back BY DESIGN: without it an empty library
  // caused by a relay timeout or a Family View lock is indistinguishable from
  // a genuinely empty account, and the backend scored both as zero.
  // pricesIncluded / gameCount stay out — the backend derives both.
  it('drops the removed fields (schemaVersion / pricesIncluded / gameCount)', async () => {
    const p: any = await collectRatePayload(fakeSb(), 1);
    expect('schemaVersion' in p).toBe(false);
    expect('capturedAt' in p).toBe(false);
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
    sb.steam.getAvatarDataUrl = async () => null;
    sb.steam.getOwnedGames = async () => ({ games: [], pricesIncluded: true, ready: false });
    sb.steam.getInventory = async () => ({ items: [], perApp: [], partial: true });
    const p = await collectRatePayload(sb, 1);
    expect(p.account.email).toBeNull();
    expect(p.account.avatar).toBeNull();
    expect(p.account.level).toBeNull();
    expect(p.library.games).toEqual([]);
    expect(p.inventory.partial).toBe(true);
    expect(p.inventory.item_count).toBe(0);
  });
});

// The library block used to carry NO health signal: a library emptied by a
// relay timeout, by Family View, or by a genuinely empty account all produced
// the identical payload. Inventory always had `partial` + `per_app[].error`;
// library now carries `ready` and `family_shared_excluded` for the same reason.
describe('library diagnostics', () => {
  it('reports ready=false when the collection never populated', async () => {
    const sb = fakeSb({ steam: { getOwnedGames: async () => ({ games: [], pricesIncluded: true, ready: false, familySharedExcluded: 0 }) } });
    const p = await collectRatePayload(sb, 1);
    expect(p.library.ready).toBe(false);
    expect(p.library.games).toEqual([]);
  });

  it('reports how many family-shared games were excluded', async () => {
    const sb = fakeSb({ steam: { getOwnedGames: async () => ({ games: [], pricesIncluded: true, ready: true, familySharedExcluded: 200 }) } });
    const p = await collectRatePayload(sb, 1);
    expect(p.library.ready).toBe(true);
    expect(p.library.family_shared_excluded).toBe(200);
  });

  it('defaults family_shared_excluded to 0 when the relay omits it', async () => {
    const sb = fakeSb({ steam: { getOwnedGames: async () => ({ games: [], pricesIncluded: true, ready: true }) } });
    const p = await collectRatePayload(sb, 1);
    expect(p.library.family_shared_excluded).toBe(0);
  });
});

// getCurrentUserAsync never resolves when no snapshot ever arrives — that is
// its documented contract ("caller wraps в timeout если нужно"). Under a
// Family View lock the relay skips the snapshot (no strAccountName), so this
// used to hang until the native 40s CDP deadline and surface a generic
// timeout with no cause. Bound it here and fail with a machine-readable code.
describe('user wait timeout', () => {
  it('rejects with a coded error when the user snapshot never arrives', async () => {
    process.env['SB_RATE_BUDGET_MS'] = '80';
    try {
      const sb = fakeSb({ steam: { getCurrentUserAsync: () => new Promise(() => {}) } });
      const started = Date.now();
      await expect(collectRatePayload(sb, 1)).rejects.toThrow('sb_user_unavailable');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      delete process.env['SB_RATE_BUDGET_MS'];
    }
  });

  it('still propagates a rollback rejection unchanged', async () => {
    const sb = fakeSb({ steam: { getCurrentUserAsync: async () => { throw new Error('framework rolled back'); } } });
    await expect(collectRatePayload(sb, 1)).rejects.toThrow('framework rolled back');
  });
});

// Family View gates the library/inventory stores behind a PIN. Collecting
// anyway produced a confidently-wrong "empty account" payload that the backend
// scored as zero. Fail fast with a code the frontend can map to a real message.
describe('family view', () => {
  it('refuses to collect while Family View is locked', async () => {
    const sb = fakeSb({ steam: { getParentalState: async () => ({ everEnabled: true, locked: true }) } });
    await expect(collectRatePayload(sb, 1)).rejects.toThrow('sb_family_view_locked');
  });

  it('collects normally when Family View is configured but unlocked', async () => {
    const sb = fakeSb({ steam: { getParentalState: async () => ({ everEnabled: true, locked: false }) } });
    const p = await collectRatePayload(sb, 1);
    expect(p.account.family_view_locked).toBe(false);
  });

  it('collects when the state is unknown, and reports it as null', async () => {
    const sb = fakeSb({ steam: { getParentalState: async () => undefined } });
    const p = await collectRatePayload(sb, 1);
    expect(p.account.family_view_locked).toBeNull();
  });

  it('tolerates an older API without getParentalState', async () => {
    const sb = fakeSb();
    delete sb.steam.getParentalState;
    const p = await collectRatePayload(sb, 1);
    expect(p.account.family_view_locked).toBeNull();
  });
});

// C2: the phases run SEQUENTIALLY (user → parental → Promise.all), so three
// independent budgets ADD UP. 20s + 5s + 25s = 50s against the native 40s CDP
// deadline on host.getRateAccountData: the collection would be discarded whole,
// losing the very error codes this work added. One shared wall-clock deadline
// instead of three constants.
describe('collection deadline', () => {
  it('exposes a total budget that fits under the native 40s deadline', () => {
    expect(getCollectionBudgetMs()).toBeLessThan(40000);
  });

  it('rejects once the overall budget is spent, even if each phase is individually fine', async () => {
    process.env['SB_RATE_BUDGET_MS'] = '150';
    try {
      const slow = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 90));
      const sb = fakeSb({ steam: {
        getCurrentUserAsync: async () => slow({
          accountName: 'l', personaName: 'p', steamId: '7', accountId: 1, currency: 'KZT',
          balance: 0, balanceFormatted: '0', isLimited: false,
          email: async () => undefined, emailValidated: async () => undefined,
        }),
        getParentalState: async () => slow(undefined),
        getOwnedGames: async () => slow({ games: [], pricesIncluded: true, ready: true, familySharedExcluded: 0 }),
      } });
      const started = Date.now();
      await expect(collectRatePayload(sb, 1)).rejects.toThrow('sb_collection_timeout');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      delete process.env['SB_RATE_BUDGET_MS'];
    }
  });
});

// I4: a timed-out attempt must not leave its listener registered. Racing the
// promise externally abandoned the loser still subscribed, so every retry under
// a Family View lock accumulated a handler that fired on every later snapshot.
describe('user wait does not leak listeners', () => {
  it('passes a bound into getCurrentUserAsync instead of racing it', async () => {
    process.env['SB_RATE_BUDGET_MS'] = '120';
    try {
      const seen: (number | undefined)[] = [];
      const sb = fakeSb({ steam: {
        getCurrentUserAsync: (timeoutMs?: number) => {
          seen.push(timeoutMs);
          return new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`user-wait-timeout: no Steam user snapshot within ${timeoutMs}ms`)), 40));
        },
      } });
      await expect(collectRatePayload(sb, 1)).rejects.toThrow('sb_user_unavailable');
      expect(seen.length).toBe(1);
      expect(typeof seen[0]).toBe('number');   // a bound was actually passed
      expect(seen[0]!).toBeGreaterThan(0);
    } finally {
      delete process.env['SB_RATE_BUDGET_MS'];
    }
  });
});
