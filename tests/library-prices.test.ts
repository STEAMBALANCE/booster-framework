import { test, expect } from 'bun:test';
import { loadLibraryPrices } from '../src/steam-internals/library-prices';

function fakeSic(opts: {
  byId: Record<number, any>;
  unavailable?: number[];
  region?: number[];
  inflight?: Map<number, unknown>;
}) {
  const hinted: number[][] = [];
  (globalThis as any).window = { StoreItemCache: {
    m_setUnavailableApps: new Set(opts.unavailable ?? []),
    m_setUnavailableDueToCountryRestrictionApps: new Set(opts.region ?? []),
    m_mapAppsInFlight: opts.inflight ?? new Map(),
    HintLoadStoreApps: async (ids: number[]) => { hinted.push(ids); },
    GetApp: (id: number) => opts.byId[id],
  } };
  return { hinted };
}

test('maps a paid app to GamePrice from m_BestPurchaseOption (raw fields, Valve-bug-safe)', async () => {
  fakeSic({ byId: { 244210: { m_strName: 'Assetto Corsa', m_bIsFree: false, m_BestPurchaseOption: {
    final_price_in_cents: '130000', original_price_in_cents: '520000', discount_pct: 75,
    formatted_final_price: '1 300,00₸', formatted_original_price: '5 200,00₸',
  } } } });
  const m = await loadLibraryPrices([244210]);
  expect(m.get(244210)).toEqual({
    isFree: false, finalMinor: 130000, originalMinor: 520000, discountPct: 75,
    formattedFinal: '1 300,00₸', formattedOriginal: '5 200,00₸',
  });
});

test('free app → isFree, finalMinor 0', async () => {
  fakeSic({ byId: { 730: { m_strName: 'CS2', m_bIsFree: true, m_BestPurchaseOption: {} } } });
  expect((await loadLibraryPrices([730])).get(730)).toEqual({ isFree: true, finalMinor: 0,
    originalMinor: undefined, discountPct: undefined, formattedFinal: undefined, formattedOriginal: undefined });
});

test('unavailable + region-restricted apps are flagged', async () => {
  fakeSic({ byId: {}, unavailable: [622590], region: [99999] });
  const m = await loadLibraryPrices([622590, 99999]);
  expect(m.get(622590)).toEqual({ isFree: false, unavailable: true });
  expect(m.get(99999)).toEqual({ isFree: false, regionRestricted: true });
});

test('clears malformed in-flight entries before hinting', async () => {
  const inflight = new Map<number, unknown>([[1, { dataRequest: undefined }], [2, { dataRequest: {} }]]);
  fakeSic({ byId: {}, inflight });
  await loadLibraryPrices([1]);
  expect(inflight.has(1)).toBe(false); // malformed dropped
  expect(inflight.has(2)).toBe(true);  // valid kept
});

test('isFree dominates: m_bIsFree true forces finalMinor 0 even if a price is present', async () => {
  fakeSic({ byId: { 12345: { m_strName: 'Weird', m_bIsFree: true, m_BestPurchaseOption: { final_price_in_cents: '100' } } } });
  const p = (await loadLibraryPrices([12345])).get(12345);
  expect(p?.isFree).toBe(true);
  expect(p?.finalMinor).toBe(0);
});
