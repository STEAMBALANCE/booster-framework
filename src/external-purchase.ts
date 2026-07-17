import type { SbApi } from './api/api-types';

export interface ExternalPurchaseResult {
  ok: boolean;
  orderUid?: string;
  error?: string;
  message?: string;
}

// Error codes that pass through from booster-checkout untouched. Everything
// else (http-<status>, network, unknown) is collapsed to 'order-failed' so
// internal checkout codes never leak to steambalance.cc.
const PASSTHROUGH = new Set(['no-email', 'no-payment', 'window', 'bad-args', 'timeout']);
const REQUEST_TOPIC = 'booster-checkout.keys.external-purchase';
const RESULT_TOPIC = 'booster-checkout.keys.external-purchase-result';
const TIMEOUT_MS = 30_000;

function normalize(d: { ok?: unknown; orderUid?: unknown; error?: unknown; message?: unknown }): ExternalPurchaseResult {
  if (d.ok === true) {
    return typeof d.orderUid === 'string' ? { ok: true, orderUid: d.orderUid } : { ok: true };
  }
  const raw = typeof d.error === 'string' ? d.error : 'order-failed';
  const error = PASSTHROUGH.has(raw) ? raw : 'order-failed';
  const message = typeof d.message === 'string' ? d.message : undefined;
  return message ? { ok: false, error, message } : { ok: false, error };
}

// Builds the delegate that the native host.purchaseKey op evals on Main:
// window[sec.keysPurchase](itemId, gameName). It never throws — every outcome
// is a resolved ExternalPurchaseResult, so the C++ wrapper reports resolved:true
// and the checkout-host bridge resolves the page Promise with the object.
export function makeExternalPurchase(
  api: SbApi,
): (itemId: unknown, gameName?: unknown) => Promise<ExternalPurchaseResult> {
  let seq = 0;
  return (itemId, gameName) => new Promise<ExternalPurchaseResult>((resolve) => {
    if (typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0) {
      resolve({ ok: false, error: 'bad-args' });
      return;
    }
    // Cap to 150 chars: gameName is display-only (mirrors the checkout-side
    // cap in keys-install.ts) and must keep the JSON payload well under the
    // bus's 16 KB sync-throw limit (bus.ts) so this executor never throws.
    const gn = typeof gameName === 'string' && gameName ? gameName.slice(0, 150) : undefined;
    const reqId = `xp-${++seq}-${Date.now()}`;
    let done = false;
    const finish = (r: ExternalPurchaseResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(r);
    };
    const unsub = api.bus.subscribe(RESULT_TOPIC, (data) => {
      const d = data as { reqId?: unknown } | null;
      if (!d || d.reqId !== reqId) return;
      finish(normalize(d as Parameters<typeof normalize>[0]));
    });
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TIMEOUT_MS);
    api.bus.publish(REQUEST_TOPIC, gn ? { reqId, itemId, gameName: gn } : { reqId, itemId });
  });
}
