import { describe, test, expect } from 'bun:test';
import { makeExternalPurchase } from '../src/external-purchase';

// Minimal in-context bus fake with LOCAL delivery (mirrors the real local-echo)
// and the real bus's synchronous 16 KB payload-size throw (src/api/bus.ts),
// so a test can assert makeExternalPurchase never lets that throw escape.
function makeBus() {
  const subs = new Map<string, Set<(d: unknown) => void>>();
  const published: Array<{ topic: string; data: any }> = [];
  return {
    published,
    publish: (topic: string, data: unknown) => {
      const byteLen = new TextEncoder().encode(JSON.stringify(data ?? null)).byteLength;
      if (byteLen > 16384) throw new Error(`sb.bus.publish: payload too large (${byteLen} > 16384)`);
      published.push({ topic, data });
      subs.get(topic)?.forEach((cb) => cb(data));
    },
    subscribe: (topic: string, cb: (d: unknown) => void) => {
      let s = subs.get(topic); if (!s) { s = new Set(); subs.set(topic, s); }
      s.add(cb); return () => s!.delete(cb);
    },
  };
}
const apiWith = (bus: any) => ({ bus } as any);

describe('makeExternalPurchase', () => {
  test('bad itemId resolves bad-args without publishing', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    expect(await purchase(0)).toEqual({ ok: false, error: 'bad-args' });
    expect(await purchase(-3)).toEqual({ ok: false, error: 'bad-args' });
    expect(await purchase(1.5)).toEqual({ ok: false, error: 'bad-args' });
    expect(await purchase('7' as any)).toEqual({ ok: false, error: 'bad-args' });
    expect(bus.published.length).toBe(0);
  });

  test('publishes external-purchase with reqId + itemId + gameName', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    // Auto-answer so the promise settles and the 30s timer is cleared (no open handle).
    bus.subscribe('booster-checkout.keys.external-purchase', (d: any) => {
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: d.reqId, ok: true, orderUid: 'u' });
    });
    await purchase(7, 'Earth 2160');
    const p = bus.published.find((x) => x.topic === 'booster-checkout.keys.external-purchase');
    expect(p).toBeTruthy();
    expect(typeof p!.data.reqId).toBe('string');
    expect(p!.data.itemId).toBe(7);
    expect(p!.data.gameName).toBe('Earth 2160');
  });

  test('never throws: a pathological gameName is capped to 150 chars, not passed through unbounded', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    bus.subscribe('booster-checkout.keys.external-purchase', (d: any) => {
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: d.reqId, ok: true, orderUid: 'u' });
    });
    const longGameName = 'x'.repeat(20000);
    await expect(purchase(7, longGameName)).resolves.toEqual({ ok: true, orderUid: 'u' });
    const p = bus.published.find((x) => x.topic === 'booster-checkout.keys.external-purchase');
    expect(p).toBeTruthy();
    expect((p!.data.gameName as string).length).toBeLessThanOrEqual(150);
  });

  test('happy path: result with orderUid resolves ok', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    // Echo a matching result the moment the request is published.
    bus.subscribe('booster-checkout.keys.external-purchase', (d: any) => {
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: d.reqId, ok: true, orderUid: 'u9' });
    });
    expect(await purchase(7)).toEqual({ ok: true, orderUid: 'u9' });
  });

  test('normalize: unmapped checkout error → order-failed, message preserved', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    bus.subscribe('booster-checkout.keys.external-purchase', (d: any) => {
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: d.reqId, ok: false, error: 'http-500', message: 'Ошибка' }); // strings-allow-cyrillic
    });
    expect(await purchase(7)).toEqual({ ok: false, error: 'order-failed', message: 'Ошибка' }); // strings-allow-cyrillic
  });

  test('normalize: passthrough codes stay as-is', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    bus.subscribe('booster-checkout.keys.external-purchase', (d: any) => {
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: d.reqId, ok: false, error: 'no-email' });
    });
    expect(await purchase(7)).toEqual({ ok: false, error: 'no-email' });
  });

  test('result for a different reqId is ignored (no cross-talk)', async () => {
    const bus = makeBus();
    const purchase = makeExternalPurchase(apiWith(bus));
    bus.subscribe('booster-checkout.keys.external-purchase', (d: any) => {
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: 'OTHER', ok: true, orderUid: 'nope' });
      bus.publish('booster-checkout.keys.external-purchase-result', { reqId: d.reqId, ok: true, orderUid: 'mine' });
    });
    expect(await purchase(7)).toEqual({ ok: true, orderUid: 'mine' });
  });
});
