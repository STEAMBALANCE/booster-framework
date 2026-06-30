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
  resolveReqMsg: () => unknown | undefined;
  resolveWrap: () => { Init: (reqMsg: unknown) => { Body: () => any } } | undefined;
  getTransport: () => unknown | undefined;
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
  const ReqMsg = deps.resolveReqMsg();
  const Wrap = deps.resolveWrap();
  const transport = deps.getTransport();
  const items: InventoryItem[] = [];
  const perApp: InventoryAppResult[] = [];
  let partial = false;

  if (!stub || !ReqMsg || !Wrap || !transport) {
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
        const r = Wrap.Init(ReqMsg);
        const b = r.Body();
        b.set_steamid(steamId);
        b.set_appid(app.appid); b.set_contextid(app.contextid); b.set_get_descriptions(true);
        b.set_language('russian'); b.set_count(PAGE_SIZE);
        if (start) b.set_start_assetid(start);
        const resp = await stub.GetInventoryItemsWithDescriptions(transport, r);
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
 *  Resolution notes (tuned LIVE against the running Steam client):
 *  - stub:   the export of the Econ-route module that owns the
 *            `GetInventoryItemsWithDescriptions` method.
 *  - ReqMsg: the request-message CLASS from the same module. Its prototype
 *            carries `set_steamid` (a request-only field — the response
 *            message has no steamid setter), which distinguishes it from the
 *            response class living in the same module.
 *  - Wrap:   the generic ServiceMethod message wrapper class whose `Init(MsgClass)`
 *            returns a holder exposing `.Body()` (field setters) and, on the
 *            response, `.GetEResult()`. The module is pinned by the distinctive
 *            `InitFromMsg` + `InitFromObject` + `GetEResult` triple (matches one
 *            module live; a bare `'Init('` / `'Body()'` triple matches ~20), and
 *            the export by three of its static initializers (`Init`,
 *            `InitFromMsg`, `InitFromObject`). Verified live: stub=tB,
 *            reqMsg=z9, wrap=w. */
export async function fetchInventory(options: Options = {}): Promise<InventoryResult> {
  const deps: InventoryDeps = {
    resolveStub: () => pickExport(resolveModuleByContent(ECON_ROUTE), (v) => !!v && typeof (v as any).GetInventoryItemsWithDescriptions === 'function') as any,
    resolveReqMsg: () => pickExport(resolveModuleByContent(ECON_ROUTE), (v) => typeof v === 'function' && !!(v as any).prototype && typeof (v as any).prototype.set_steamid === 'function'),
    resolveWrap: () => pickExport(resolveModuleByContent(['InitFromMsg', 'InitFromObject', 'GetEResult']), (v) => typeof v === 'function' && typeof (v as any).Init === 'function' && typeof (v as any).InitFromMsg === 'function' && typeof (v as any).InitFromObject === 'function') as any,
    getTransport: () => {
      const cm = (window as any).g_FriendsUIApp?.CMInterface;
      try { return typeof cm?.GetServiceTransport === 'function' ? cm.GetServiceTransport() : undefined; } catch { return undefined; }
    },
  };
  try { return await fetchInventoryWithDeps(options, deps); }
  catch { return { items: [], perApp: [], partial: true }; }
}
