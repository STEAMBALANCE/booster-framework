import { test, expect } from 'bun:test';

// Provide a minimal window global before importing the bridge module,
// because createBridge() touches window.__sb_resolve at construction time.
// @ts-expect-error
globalThis.window = globalThis;

import { createBridge } from '../src/bridge';

test('bridge sends payload via __sb_native and resolves on __sb_resolve', async () => {
  let lastSent: any = null;
  // Set __sb_native BEFORE createBridge so it is captured at construction (B3).
  window.__sb_native = (s: string) => { lastSent = JSON.parse(s); };
  const bridge = createBridge();

  const p = bridge.call('foo', { x: 1 });
  const id = lastSent?.requestId;
  expect(typeof id).toBe('number');
  expect(id).toBeGreaterThanOrEqual(1);
  expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  expect(lastSent).toMatchObject({ op: 'foo', args: { x: 1 } });

  // @ts-expect-error
  window.__sb_resolve(id, { ok: true, result: { y: 2 } });
  await expect(p).resolves.toEqual({ y: 2 });
});

test('bridge rejects on response.ok=false', async () => {
  // Use transport so the requestId can be captured dynamically (B2: ids are random).
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  const p = bridge.call('foo');
  const id = JSON.parse(sent[0]).requestId as number;
  // @ts-expect-error
  window.__sb_resolve(id, { ok: false, error: 'nope' });
  await expect(p).rejects.toThrow('nope');
});

test('bridge rejects if __sb_native not installed', async () => {
  // Delete BEFORE createBridge so the captured nativeSend is undefined (B3).
  delete window.__sb_native;
  const bridge = createBridge();
  await expect(bridge.call('foo')).rejects.toThrow('native bridge not installed');
});

test('bridge rejects payloads larger than 64 KB (defense-in-depth)', async () => {
  // Use transport; payload cap fires before sendRaw so native routing is irrelevant.
  let nativeCalled = false;
  const bridge = createBridge({ send: () => { nativeCalled = true; } });
  const big = 'x'.repeat(70 * 1024);
  await expect(bridge.call('foo', { big })).rejects.toThrow('payload too large');
  expect(nativeCalled).toBe(false);
});

test('bridge rejects with timeout error when native never resolves', async () => {
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
    // Use transport injection so __sb_native capture state does not matter (B3).
    const bridge = createBridge({ send: (_: string) => { /* swallow — never resolve */ } });
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
  // Cancel the pending timer by resolving the call; prevents a 10-second
  // timeout from firing as an unhandled rejection during a later test file.
  // @ts-expect-error - __sb_resolve lives on the window global
  window.__sb_resolve(env.requestId, { ok: true, result: null });
});

test('call without pluginId opt omits pluginId field', () => {
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  void bridge.call('config_read', { name: 'foo' });
  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]);
  expect(env.pluginId).toBeUndefined();
  // Cancel the pending timer by resolving the call.
  // @ts-expect-error - __sb_resolve lives on the window global
  window.__sb_resolve(env.requestId, { ok: true, result: null });
});

// B2: requestIds are random nonces, not sequential counters.
test('requestIds are random nonces in [1, 2^53-1] with no collisions', () => {
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  const N = 100;
  for (let i = 0; i < N; i++) void bridge.call('x');
  const ids = sent.map(s => JSON.parse(s).requestId as number);
  // All ids must be safe integers in [1, MAX_SAFE_INTEGER].
  for (const id of ids) {
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThanOrEqual(1);
    expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  }
  // All distinct — no collisions across 100 calls.
  expect(new Set(ids).size).toBe(N);
  // Non-sequential: random values drawn from [1, 2^53-1] produce an enormous
  // spread; sequential values n..n+99 have range exactly 99.
  const range = Math.max(...ids) - Math.min(...ids);
  expect(range).toBeGreaterThan(1_000_000);
  // Cancel all pending timers by resolving each call; 100 void'd calls each
  // schedule a 10-second timer that would fire as unhandled rejections during
  // later test files running in the same process.
  for (const id of ids) {
    // @ts-expect-error - __sb_resolve lives on the window global
    window.__sb_resolve(id, { ok: true, result: null });
  }
});

// B3: __sb_native is captured once at createBridge() construction. A plugin that
// reassigns window.__sb_native afterward cannot intercept subsequent call/notify
// envelopes — those still route through the originally-captured reference.

test('call: __sb_native captured at construction; reassigning after does not reroute', () => {
  const origCalls: string[] = [];
  const spyCalls: string[] = [];
  window.__sb_native = (s: string) => origCalls.push(s);
  const bridge = createBridge();
  // Reassign after construction — must NOT affect routing.
  window.__sb_native = (s: string) => spyCalls.push(s);
  void bridge.call('x', {});
  expect(origCalls).toHaveLength(1);
  expect(spyCalls).toHaveLength(0);
  // Cancel the pending timer by resolving the call.
  const callId = (JSON.parse(origCalls[0]) as { requestId: number }).requestId;
  // @ts-expect-error - __sb_resolve lives on the window global
  window.__sb_resolve(callId, { ok: true, result: null });
});

test('notify: __sb_native captured at construction; reassigning after does not reroute', () => {
  const origCalls: string[] = [];
  const spyCalls: string[] = [];
  window.__sb_native = (s: string) => origCalls.push(s);
  const bridge = createBridge();
  // Reassign after construction — must NOT affect routing.
  window.__sb_native = (s: string) => spyCalls.push(s);
  bridge.notify('log', 'test-plugin', {});
  expect(origCalls).toHaveLength(1);
  expect(spyCalls).toHaveLength(0);
});

// B5: resolver registered non-enumerable under the secret name
test('B5: resolver registered non-enumerable under secret name', () => {
  // @ts-expect-error
  globalThis.window = globalThis;
  const bridge = createBridge(undefined, { resolverName: 'sb_abcd' });
  const desc = Object.getOwnPropertyDescriptor(window, 'sb_abcd');
  expect(desc).toBeDefined();
  expect(desc!.enumerable).toBe(false);
  // Clean up
  delete (window as any)['sb_abcd'];
});

test('B5: pending call resolves via secret name global', async () => {
  // @ts-expect-error
  globalThis.window = globalThis;
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) }, { resolverName: 'sb_test1' });
  const p = bridge.call('foo', {});
  const id = JSON.parse(sent[0]).requestId as number;
  // Invoke the secret resolver
  (window as any)['sb_test1'](id, { ok: true, result: { v: 99 } });
  await expect(p).resolves.toEqual({ v: 99 });
  delete (window as any)['sb_test1'];
});

test('B5: overwriting window.__sb_resolve does NOT intercept pending call with secret name', async () => {
  // @ts-expect-error
  globalThis.window = globalThis;
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) }, { resolverName: 'sb_test2' });
  const p = bridge.call('foo', {});
  const id = JSON.parse(sent[0]).requestId as number;
  // Try to intercept via __sb_resolve
  let intercepted = false;
  window.__sb_resolve = () => { intercepted = true; };
  // Must not resolve via __sb_resolve
  // Fire via secret name instead
  (window as any)['sb_test2'](id, { ok: true, result: 'ok' });
  await expect(p).resolves.toBe('ok');
  expect(intercepted).toBe(false);
  delete (window as any)['sb_test2'];
});

test('B5: no resolverName falls back to window.__sb_resolve (back-compat)', async () => {
  // @ts-expect-error
  globalThis.window = globalThis;
  const sent: string[] = [];
  const bridge = createBridge({ send: (j) => sent.push(j) });
  const p = bridge.call('foo', {});
  const id = JSON.parse(sent[0]).requestId as number;
  // @ts-expect-error
  window.__sb_resolve(id, { ok: true, result: 'compat' });
  await expect(p).resolves.toBe('compat');
});
