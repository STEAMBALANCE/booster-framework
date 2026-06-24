import { test, expect } from 'bun:test';

// Provide a minimal window global before importing the bridge module,
// because createBridge() touches window.__sb_resolve at construction time.
// @ts-expect-error
globalThis.window = globalThis;

import { createBridge, hideNativeBridgeGlobal } from '../src/bridge';

test('bridge sends payload via __sb_native and resolves on __sb_resolve', async () => {
  const bridge = createBridge();
  let lastSent: any = null;
  // @ts-expect-error
  globalThis.window = globalThis;
  window.__sb_native = (s: string) => { lastSent = JSON.parse(s); };

  const p = bridge.call('foo', { x: 1 });
  expect(lastSent).toEqual({ op: 'foo', args: { x: 1 }, requestId: 1 });

  // @ts-expect-error
  window.__sb_resolve(1, { ok: true, result: { y: 2 } });
  await expect(p).resolves.toEqual({ y: 2 });
});

test('bridge rejects on response.ok=false', async () => {
  const bridge = createBridge();
  window.__sb_native = (_: string) => {};
  const p = bridge.call('foo');
  // @ts-expect-error
  window.__sb_resolve(2, { ok: false, error: 'nope' });
  await expect(p).rejects.toThrow('nope');
});

test('bridge rejects if __sb_native not installed', async () => {
  delete window.__sb_native;
  const bridge = createBridge();
  await expect(bridge.call('foo')).rejects.toThrow('native bridge not installed');
});

test('bridge rejects payloads larger than 64 KB (defense-in-depth)', async () => {
  const bridge = createBridge();
  let nativeCalled = false;
  window.__sb_native = (_: string) => { nativeCalled = true; };
  // Build a string that, after JSON-stringification, exceeds 64 KB.
  const big = 'x'.repeat(70 * 1024);
  await expect(bridge.call('foo', { big })).rejects.toThrow('payload too large');
  expect(nativeCalled).toBe(false);
});

test('bridge rejects with timeout error when native never resolves', async () => {
  const bridge = createBridge();
  // Capture the timer callback bridge.ts schedules instead of letting it
  // sleep for the real BRIDGE_TIMEOUT_MS = 10 s. Patch the global so the
  // call site's lexical reference resolves to our stub. Restored after.
  const origSetTimeout = globalThis.setTimeout;
  let scheduled: (() => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setTimeout = ((cb: () => void, _ms: number) => {
    scheduled = cb;
    return 0 as unknown as ReturnType<typeof origSetTimeout>;
  });
  try {
    window.__sb_native = (_: string) => { /* swallow — never resolve */ };
    const p = bridge.call('hangOp');
    // Bridge should have scheduled exactly one timer for the timeout path.
    expect(scheduled).not.toBeNull();
    // Fire the timer synchronously — simulates the 10 s elapsing.
    scheduled!();
    await expect(p).rejects.toThrow(/timeout for op 'hangOp' after 10000ms/);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('notify sends fire-and-forget envelope with kind=notify', () => {
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  bridge.notify('log', 'booster-test', { level: 'info', msg: 'hello' });
  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]);
  expect(env).toEqual({
    op: 'log',
    kind: 'notify',
    pluginId: 'booster-test',
    args: { level: 'info', msg: 'hello' },
  });
  expect(env.requestId).toBeUndefined();
});

test('call with pluginId opt includes pluginId in envelope', () => {
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  void bridge.call('config_read', { name: 'foo' }, { pluginId: 'booster-test' });
  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]);
  expect(env.op).toBe('config_read');
  expect(env.pluginId).toBe('booster-test');
  expect(env.args).toEqual({ name: 'foo' });
  expect(typeof env.requestId).toBe('number');
});

test('call without pluginId opt omits pluginId field', () => {
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  void bridge.call('config_read', { name: 'foo' });
  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]);
  expect(env.pluginId).toBeUndefined();
});

test('bridge can keep using captured native callback after __sb_native is hidden', async () => {
  let lastSent: any = null;
  window.__sb_native = (s: string) => { lastSent = JSON.parse(s); };
  const bridge = createBridge();

  hideNativeBridgeGlobal();
  expect(window.__sb_native).toBeUndefined();

  const p = bridge.call('after_hide', {});
  expect(lastSent.op).toBe('after_hide');
  window.__sb_resolve!(lastSent.requestId, { ok: true, result: { ok: true } });
  await expect(p).resolves.toEqual({ ok: true });
});
