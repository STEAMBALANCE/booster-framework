import { test, expect } from 'bun:test';
import { fetchInventoryWithDeps } from '../src/steam-internals/inventory';

// A fake Econ stub + request wrapper + transport, paginating two pages.
function makeDeps(pages: Record<string, { assets: any[]; descriptions: any[]; more_items?: number; last_assetid?: string; total_inventory_count?: number }>) {
  let call = 0;
  const reqState: any = {};
  const Wrap = { Init: () => ({ Body: () => ({
    set_steamid: () => {}, set_appid: (v: number) => { reqState.appid = v; },
    set_contextid: () => {}, set_get_descriptions: () => {}, set_language: () => {},
    set_count: () => {}, set_start_assetid: (v: string) => { reqState.start = v; },
  }) }) };
  const stub = { GetInventoryItemsWithDescriptions: async () => {
    const key = (reqState.start ?? '0'); const body = pages[key]!;
    call++;
    return { GetEResult: () => 1, Body: () => ({ toObject: () => body }) };
  } };
  return { resolveStub: () => stub, resolveReqMsg: () => ({}), resolveWrap: () => Wrap, getTransport: () => ({}), calls: () => call };
}

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
});

test('fetchInventory isolates a failing app and sets partial', async () => {
  // failing app is in the MIDDLE; asserts subsequent app (730) still runs ok
  const deps = makeDeps({ '0': { assets: [], descriptions: [], total_inventory_count: 0 } });
  const base = deps.resolveStub();
  let n = 0;
  (deps as any).resolveStub = () => ({ GetInventoryItemsWithDescriptions: async () => {
    n++; if (n === 1) throw new Error('boom'); return base.GetInventoryItemsWithDescriptions(); } });
  const r = await fetchInventoryWithDeps(
    { apps: [{ appid: 570, contextid: '2' }, { appid: 730, contextid: '2' }, { appid: 753, contextid: '6' }] },
    deps as any,
  );
  expect(r.partial).toBe(true);
  expect(r.perApp.find((a) => a.appid === 570)!.ok).toBe(false);
  // 730 ran after the mid-list failure and succeeded
  expect(r.perApp.find((a) => a.appid === 730)!.ok).toBe(true);
  // 753 also ran and succeeded
  expect(r.perApp.find((a) => a.appid === 753)!.ok).toBe(true);
});

test('fetchInventory eresult failure sets perApp.ok=false and partial=true', async () => {
  const deps = makeDeps({ '0': { assets: [], descriptions: [], total_inventory_count: 0 } });
  const base = deps.resolveStub();
  let n = 0;
  (deps as any).resolveStub = () => ({ GetInventoryItemsWithDescriptions: async () => {
    n++;
    if (n === 1) return { GetEResult: () => 2, Body: () => ({ toObject: () => ({}) }) };
    return base.GetInventoryItemsWithDescriptions();
  } });
  const r = await fetchInventoryWithDeps(
    { apps: [{ appid: 570, contextid: '2' }, { appid: 730, contextid: '2' }] },
    deps as any,
  );
  expect(r.partial).toBe(true);
  expect(r.perApp.find((a) => a.appid === 570)!.ok).toBe(false);
  expect(r.perApp.find((a) => a.appid === 570)!.error).toBe('eresult 2');
  // subsequent app still ran fine
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
