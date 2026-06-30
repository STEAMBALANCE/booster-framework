import type { GamePrice } from '../api/api-types';
import { nativeWarn } from '../native-warn';

interface BestPurchaseOption {
  final_price_in_cents?: string;
  original_price_in_cents?: string;
  discount_pct?: number;
  formatted_final_price?: string;
  formatted_original_price?: string;
}
interface StoreItemCacheLike {
  HintLoadStoreApps?: (appids: number[], dataRequest: object) => Promise<unknown>;
  GetApp?: (appid: number) => { m_strName?: string; m_bIsFree?: boolean; m_BestPurchaseOption?: BestPurchaseOption } | undefined;
  m_setUnavailableApps?: Set<number>;
  m_setUnavailableDueToCountryRestrictionApps?: Set<number>;
  m_mapAppsInFlight?: Map<number, { dataRequest?: unknown }>;
}

/** Load current store prices for appids by riding the client's own GetItems
 *  machinery (StoreItemCache → IStoreBrowseService/GetItems, auto-batched at 250).
 *  Returns a map appid → GamePrice. Missing/unknown apps are simply absent.
 *  Never throws. */
export async function loadLibraryPrices(appids: number[]): Promise<Map<number, GamePrice>> {
  const out = new Map<number, GamePrice>();
  const w = typeof window !== 'undefined' ? window : undefined;
  const sic = (w as unknown as { StoreItemCache?: StoreItemCacheLike } | undefined)?.StoreItemCache;
  if (!sic || typeof sic.HintLoadStoreApps !== 'function' || typeof sic.GetApp !== 'function') {
    if (w !== undefined) nativeWarn('[sb] library-prices: StoreItemCache unavailable');
    return out;
  }

  // Defensive: drop malformed in-flight entries (dataRequest === undefined) left
  // by a prior throw; they poison GetPreviousSupersetLoadPromise on the next call.
  try {
    const inflight = sic.m_mapAppsInFlight;
    if (inflight && typeof inflight.delete === 'function') {
      for (const [id, v] of inflight) { if (!v || (v as { dataRequest?: unknown }).dataRequest === undefined) inflight.delete(id); }
    }
  } catch { /* ignore */ }

  const dataRequest = {
    include_all_purchase_options: true,
    include_assets: true,
    include_release: true,
    include_basic_info: true,
  };
  try { await sic.HintLoadStoreApps(appids, dataRequest); } catch { /* read whatever loaded */ }

  const unavailable = sic.m_setUnavailableApps;
  const region = sic.m_setUnavailableDueToCountryRestrictionApps;

  for (const id of appids) {
    let item: ReturnType<NonNullable<StoreItemCacheLike['GetApp']>>;
    try { item = sic.GetApp!(id); } catch { item = undefined; }
    if (!item) {
      if (region?.has(id)) out.set(id, { isFree: false, regionRestricted: true });
      else if (unavailable?.has(id)) out.set(id, { isFree: false, unavailable: true });
      continue;
    }
    const bpo = item.m_BestPurchaseOption;
    const finalStr = bpo?.final_price_in_cents;
    const isFree = !!item.m_bIsFree || !finalStr;
    out.set(id, {
      isFree,
      finalMinor: isFree ? 0 : parseInt(finalStr!, 10),
      originalMinor: bpo?.original_price_in_cents ? parseInt(bpo.original_price_in_cents, 10) : undefined,
      discountPct: bpo?.discount_pct || undefined,
      formattedFinal: bpo?.formatted_final_price,
      formattedOriginal: bpo?.formatted_original_price,
    });
  }
  return out;
}
