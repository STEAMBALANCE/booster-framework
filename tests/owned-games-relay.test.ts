import { test, expect } from 'bun:test';
import { handleGetOwnedGames } from '../src/relay/owned-games';

function fakeBc() { const posted: any[] = []; return { posted, bc: { postMessage: (m: any) => posted.push(m) } as any }; }

test('handleGetOwnedGames posts mapped games without prices when includePrices=false', async () => {
  (globalThis as any).window = { collectionStore: { allGamesCollection: { allApps: [
    { appid: 730, display_name: 'CS2', app_type: 1, minutes_playtime_forever: 10 },
  ] } } };
  const { posted, bc } = fakeBc();
  await handleGetOwnedGames({ kind: 'get-owned-games', requestId: 5, includePrices: false }, bc);
  expect(posted.length).toBe(1);
  expect(posted[0].kind).toBe('owned-games-ok');
  expect(posted[0].requestId).toBe(5);
  expect(posted[0].result.ready).toBe(true);
  expect(posted[0].result.pricesIncluded).toBe(false);
  expect(posted[0].result.games[0].appid).toBe(730);
  expect(posted[0].result.games[0].price).toBeUndefined();
});

test('handleGetOwnedGames attaches prices + currency when includePrices=true', async () => {
  (globalThis as any).window = {
    collectionStore: { allGamesCollection: { allApps: [{ appid: 244210, display_name: 'AC', app_type: 1, minutes_playtime_forever: 1 }] } },
    StoreItemCache: {
      m_setUnavailableApps: new Set(), m_setUnavailableDueToCountryRestrictionApps: new Set(), m_mapAppsInFlight: new Map(),
      HintLoadStoreApps: async () => {},
      GetApp: () => ({ m_strName: 'AC', m_bIsFree: false, m_BestPurchaseOption: { final_price_in_cents: '130000', formatted_final_price: '1 300,00₸' } }),
    },
  };
  const { posted, bc } = fakeBc();
  await handleGetOwnedGames({ kind: 'get-owned-games', requestId: 6, includePrices: true }, bc);
  expect(posted[0].requestId).toBe(6);
  expect(posted[0].result.pricesIncluded).toBe(true);
  expect(posted[0].result.games[0].price.finalMinor).toBe(130000);
  expect(posted[0].result.currency).toBe('KZT');
});
