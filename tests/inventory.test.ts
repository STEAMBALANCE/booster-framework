import { test, expect } from 'bun:test';
import { fetchInventoryWithDeps } from '../src/steam-internals/inventory';

// A fake Econ stub + transport. The current Steam client's ServiceMethod stubs
// take a PLAIN request object directly (stub.Method(transport, {steamid, appid,
// …})) and return a response exposing GetEResult() + Body().toObject() — the
// same convention account-level.ts::cmLevel uses. Pagination is driven by the
// request's `start_assetid`.
function makeDeps(pages: Record<string, { assets: any[]; descriptions: any[]; more_items?: number; last_assetid?: string; total_inventory_count?: number }>) {
  let call = 0;
  const sent: any[] = [];
  const stub = { GetInventoryItemsWithDescriptions: async (_transport: unknown, req: any) => {
    sent.push(req);
    const key = (req?.start_assetid ?? '0'); const body = pages[key]!;
    call++;
    return { GetEResult: () => 1, Body: () => ({ toObject: () => body }) };
  } };
  return { resolveStub: () => stub, getTransport: () => ({}), calls: () => call, sent: () => sent };
}

test('fetchInventory sends a plain request object with the expected fields', async () => {
  const deps = makeDeps({ '0': { assets: [], descriptions: [], total_inventory_count: 0 } });
  await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }] }, deps as any);
  const req = deps.sent()[0];
  expect(req.appid).toBe(753);
  expect(req.contextid).toBe('6');
  expect(req.get_descriptions).toBe(true);
  expect(req.language).toBe('russian');
  expect(typeof req.count).toBe('number');
  // steamid key present (value may be undefined off-client)
  expect('steamid' in req).toBe(true);
});

test('fetchInventory paginates and maps slim items', async () => {
  const deps = makeDeps({
    '0': { assets: [{ assetid: 'a1', classid: 'c1', instanceid: 'i1', amount: '1' }], descriptions: [{ classid: 'c1', instanceid: 'i1', market_hash_name: '620-Chell', marketable: 1, tradable: 1, market_fee_app: 620, type: 'Card' }], more_items: 1, last_assetid: 'a1', total_inventory_count: 2 },
    'a1': { assets: [{ assetid: 'a2', classid: 'c1', instanceid: 'i1', amount: '1' }], descriptions: [{ classid: 'c1', instanceid: 'i1', market_hash_name: '620-Chell', marketable: 1, tradable: 1, market_fee_app: 620, type: 'Card' }], total_inventory_count: 2 },
  });
  const r = await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }] }, deps as any);
  expect(r.partial).toBe(false);
  expect(r.items.length).toBe(2);
  expect(r.items[0]).toEqual({ appid: 753, contextid: '6', assetid: 'a1', classid: 'c1', instanceid: 'i1', amount: 1, marketHashName: '620-Chell', marketName: undefined, name: undefined, type: 'Card', marketable: true, tradable: true, marketFeeApp: 620, iconUrl: undefined });
  expect(r.perApp[0]).toEqual({ appid: 753, contextid: '6', totalCount: 2, fetched: 2, ok: true });
  // second page requested with start_assetid = last_assetid
  expect(deps.sent()[1].start_assetid).toBe('a1');
});

test('fetchInventory isolates a failing app and sets partial', async () => {
  const deps = makeDeps({ '0': { assets: [], descriptions: [], total_inventory_count: 0 } });
  const base = deps.resolveStub();
  let n = 0;
  (deps as any).resolveStub = () => ({ GetInventoryItemsWithDescriptions: async (tr: unknown, req: any) => {
    n++; if (n === 1) throw new Error('boom'); return base.GetInventoryItemsWithDescriptions(tr, req); } });
  const r = await fetchInventoryWithDeps(
    { apps: [{ appid: 570, contextid: '2' }, { appid: 730, contextid: '2' }, { appid: 753, contextid: '6' }] },
    deps as any,
  );
  expect(r.partial).toBe(true);
  expect(r.perApp.find((a) => a.appid === 570)!.ok).toBe(false);
  expect(r.perApp.find((a) => a.appid === 730)!.ok).toBe(true);
  expect(r.perApp.find((a) => a.appid === 753)!.ok).toBe(true);
});

test('fetchInventory eresult failure sets perApp.ok=false and partial=true', async () => {
  const deps = makeDeps({ '0': { assets: [], descriptions: [], total_inventory_count: 0 } });
  const base = deps.resolveStub();
  let n = 0;
  (deps as any).resolveStub = () => ({ GetInventoryItemsWithDescriptions: async (tr: unknown, req: any) => {
    n++;
    if (n === 1) return { GetEResult: () => 2, Body: () => ({ toObject: () => ({}) }) };
    return base.GetInventoryItemsWithDescriptions(tr, req);
  } });
  const r = await fetchInventoryWithDeps(
    { apps: [{ appid: 570, contextid: '2' }, { appid: 730, contextid: '2' }] },
    deps as any,
  );
  expect(r.partial).toBe(true);
  expect(r.perApp.find((a) => a.appid === 570)!.ok).toBe(false);
  expect(r.perApp.find((a) => a.appid === 570)!.error).toBe('eresult 2');
  expect(r.perApp.find((a) => a.appid === 730)!.ok).toBe(true);
});

test('fetchInventory truncates at maxItemsPerApp and marks partial', async () => {
  const deps = makeDeps({
    '0': { assets: [{ assetid: 'a1', classid: 'c1', instanceid: 'i1', amount: '1' }], descriptions: [{ classid: 'c1', instanceid: 'i1', market_hash_name: 'x', marketable: 0, tradable: 0 }], more_items: 1, last_assetid: 'a1', total_inventory_count: 9 },
  });
  const r = await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }], maxItemsPerApp: 1 }, deps as any);
  expect(r.items.length).toBe(1);
  expect(r.partial).toBe(true);
});

test('fetchInventory returns machinery-unavailable when stub or transport missing', async () => {
  const noStub = await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }] }, { resolveStub: () => undefined, getTransport: () => ({}) } as any);
  expect(noStub.perApp[0].ok).toBe(false);
  expect(noStub.perApp[0].error).toBe('inventory machinery unavailable');
  const noTransport = await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }] }, { resolveStub: () => ({ GetInventoryItemsWithDescriptions: async () => ({}) }), getTransport: () => undefined } as any);
  expect(noTransport.perApp[0].ok).toBe(false);
});

// Regression: DEFAULT_MAX_PER_APP was equal to PAGE_SIZE (both 2000), so
// `fetched >= maxPerApp` tripped the moment the first full page landed and the
// second page was never requested. Pagination existed but never ran at
// defaults — the exact case of a card-heavy 753/6 inventory.
test('paginates past the first full page at DEFAULT options', async () => {
  const page = (n: number, start: number) => ({
    assets: Array.from({ length: n }, (_, i) => ({ assetid: `a${start + i}`, classid: 'c1', instanceid: 'i1', amount: '1' })),
    descriptions: [{ classid: 'c1', instanceid: 'i1', market_hash_name: 'Card', marketable: 1, tradable: 1 }],
  });
  const deps = makeDeps({
    '0':     { ...page(2000, 0),    more_items: 1, last_assetid: 'a1999', total_inventory_count: 2500 },
    'a1999': { ...page(500, 2000),  total_inventory_count: 2500 },
  });
  // No maxItemsPerApp override — this is what rate-account actually calls with.
  const r = await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }] }, deps as any);
  expect(r.items.length).toBe(2500);
  expect(r.perApp[0]!.fetched).toBe(2500);
  expect(r.partial).toBe(false);
});

test('an explicit maxItemsPerApp still truncates and marks partial', async () => {
  const deps = makeDeps({
    '0': {
      assets: Array.from({ length: 10 }, (_, i) => ({ assetid: `a${i}`, classid: 'c1', instanceid: 'i1', amount: '1' })),
      descriptions: [{ classid: 'c1', instanceid: 'i1', market_hash_name: 'Card', marketable: 1, tradable: 1 }],
      more_items: 1, last_assetid: 'a9', total_inventory_count: 99,
    },
  });
  const r = await fetchInventoryWithDeps({ apps: [{ appid: 753, contextid: '6' }], maxItemsPerApp: 10 }, deps as any);
  expect(r.items.length).toBe(10);
  expect(r.partial).toBe(true);
});

// `per_app: []` used to be the signature of a swallowed exception, which the
// backend could not tell apart from "no partitions were asked for". Keep the
// per-app rows so the failure is attributable.
test('a stub that throws outright still reports per-app diagnostics', async () => {
  const deps = { resolveStub: () => { throw new Error('webpack blew up'); }, getTransport: () => ({}) };
  const r = await fetchInventoryWithDeps({ apps: [{ appid: 730, contextid: '2' }] }, deps as any);
  expect(r.partial).toBe(true);
  expect(r.items).toEqual([]);
  expect(r.perApp.length).toBe(1);
  expect(r.perApp[0]!.ok).toBe(false);
  expect(String(r.perApp[0]!.error)).toContain('webpack blew up');
});
