import type { AppContext, InventoryItem, InventoryAppResult, InventoryResult } from '../api/api-types';
import { resolveModuleByContent, pickExport } from './webpack-modules';
import { nativeWarn } from '../native-warn';

const ECON_ROUTE = 'Econ.GetInventoryItemsWithDescriptions#1';
const DEFAULT_APPS: AppContext[] = [
  { appid: 730, contextid: '2' }, { appid: 570, contextid: '2' }, { appid: 440, contextid: '2' },
  { appid: 252490, contextid: '2' }, { appid: 753, contextid: '6' },
];
const DEFAULT_MAX_PER_APP = 2000;
// PAGE_SIZE 2000 (≤ the server's 5000 cap from spec §5.3) — keeps each GetItems
// page modest; pagination via more_items/last_assetid handles larger inventories.
const PAGE_SIZE = 2000;

export interface InventoryDeps {
  resolveStub: () => { GetInventoryItemsWithDescriptions: (transport: unknown, req: unknown) => Promise<any> } | undefined;
  getTransport: () => unknown | undefined;
}

/** Request shape the current-client ServiceMethod stub accepts directly (plain
 *  object). Field names are the protobuf snake_case names. */
interface InventoryRequest {
  steamid: string | undefined;
  appid: number;
  contextid: string;
  get_descriptions: boolean;
  language: string;
  count: number;
  start_assetid?: string;
}

interface Options { apps?: AppContext[]; maxItemsPerApp?: number; includeIcons?: boolean; }

function descKey(d: { classid?: string; instanceid?: string }): string { return `${d.classid}_${d.instanceid}`; }

function mapItems(appid: number, contextid: string, body: any, includeIcons: boolean): InventoryItem[] {
  const descs = new Map<string, any>();
  for (const d of (body.descriptions ?? [])) descs.set(descKey(d), d);
  return (body.assets ?? []).map((a: any) => {
    const d = descs.get(`${a.classid}_${a.instanceid}`) ?? {};
    return {
      appid, contextid, assetid: String(a.assetid), classid: String(a.classid), instanceid: String(a.instanceid),
      amount: Number(a.amount ?? 1),
      marketHashName: d.market_hash_name, marketName: d.market_name, name: d.name, type: d.type,
      marketable: !!d.marketable, tradable: !!d.tradable, marketFeeApp: d.market_fee_app,
      iconUrl: includeIcons ? d.icon_url : undefined,
    } as InventoryItem;
  });
}

/** Pure, dependency-injected core (unit-tested). */
export async function fetchInventoryWithDeps(options: Options, deps: InventoryDeps): Promise<InventoryResult> {
  const apps = options.apps ?? DEFAULT_APPS;
  const maxPerApp = options.maxItemsPerApp ?? DEFAULT_MAX_PER_APP;
  const includeIcons = !!options.includeIcons;
  const stub = deps.resolveStub();
  const transport = deps.getTransport();
  const items: InventoryItem[] = [];
  const perApp: InventoryAppResult[] = [];
  let partial = false;

  if (!stub || !transport) {
    nativeWarn('[sb] inventory: CM machinery unavailable');
    return { items: [], perApp: apps.map((a) => ({ ...a, fetched: 0, ok: false, error: 'inventory machinery unavailable' })), partial: true };
  }

  // Read the current SteamID64 once, defensively — in production (Main /
  // SharedJSContext) `window.App.m_CurrentUser.strSteamID` is always present;
  // off-client (unit tests) `window` may be undeclared, so guard with typeof.
  let steamId: string | undefined;
  try { steamId = typeof window !== 'undefined' ? (window as any).App?.m_CurrentUser?.strSteamID : undefined; } catch { steamId = undefined; }

  for (const app of apps) {
    let fetched = 0, totalCount: number | undefined, start: string | undefined, ok = true, err: string | undefined;
    try {
      for (;;) {
        // Current-client convention: pass a plain request object straight to the
        // stub (mirrors account-level.ts::cmLevel). The older Steam bundle wrapped
        // it via `Wrap.Init(ReqMsg).Body().set_*()`; that protobuf codegen (with
        // `set_field` setters) is gone in current builds — the message classes now
        // only carry `toObject/fromObject/serializeBinary`, so the setter path
        // silently resolved to nothing and every app reported "machinery unavailable".
        const req: InventoryRequest = {
          steamid: steamId, appid: app.appid, contextid: app.contextid,
          get_descriptions: true, language: 'russian', count: PAGE_SIZE,
        };
        if (start) req.start_assetid = start;
        const resp = await stub.GetInventoryItemsWithDescriptions(transport, req);
        const er = resp.GetEResult(); if (er !== 1) { ok = false; err = `eresult ${er}`; partial = true; break; }
        const body = resp.Body().toObject();
        totalCount = body.total_inventory_count;
        for (const it of mapItems(app.appid, app.contextid, body, includeIcons)) {
          if (fetched >= maxPerApp) { partial = true; break; }
          items.push(it); fetched++;
        }
        if (fetched >= maxPerApp) { if (body.more_items) partial = true; break; }
        if (body.more_items && body.last_assetid) {
          const next = String(body.last_assetid);
          if (next === start) break; // cursor didn't advance — avoid infinite loop
          start = next;
        } else break;
      }
    } catch (e) { ok = false; err = String((e as Error)?.message ?? e); partial = true; }
    perApp.push({ appid: app.appid, contextid: app.contextid, totalCount, fetched, ok, error: err });
  }
  return { items, perApp, partial };
}

/** Production entry: resolve live globals + webpack handles, then delegate.
 *
 *  Resolution notes (verified LIVE against the running Steam client via CDP):
 *  - stub:      the export of the Econ-route module that owns the
 *               `GetInventoryItemsWithDescriptions(transport, request)` method
 *               (an object export, not a class — matched by the method's presence).
 *  - transport: `g_FriendsUIApp.CMInterface.GetServiceTransport()`.
 *
 *  The request is a PLAIN object (protobuf snake_case fields) passed straight to
 *  the stub, and the response exposes `GetEResult()` + `Body().toObject()`. This
 *  is the same call convention `account-level.ts::cmLevel` uses and the only one
 *  the current client supports: the previous `Wrap.Init(ReqMsg).Body().set_*()`
 *  message-builder machinery relied on a protobuf codegen (with `set_field`
 *  setters) that current Steam builds no longer ship — its `ReqMsg`/`Wrap`
 *  handles resolved to nothing, so every app fell into "machinery unavailable". */
export async function fetchInventory(options: Options = {}): Promise<InventoryResult> {
  const deps: InventoryDeps = {
    resolveStub: () => pickExport(resolveModuleByContent(ECON_ROUTE), (v) => !!v && typeof (v as any).GetInventoryItemsWithDescriptions === 'function') as any,
    getTransport: () => {
      const cm = (window as any).g_FriendsUIApp?.CMInterface;
      try { return typeof cm?.GetServiceTransport === 'function' ? cm.GetServiceTransport() : undefined; } catch { return undefined; }
    },
  };
  try { return await fetchInventoryWithDeps(options, deps); }
  catch { return { items: [], perApp: [], partial: true }; }
}
