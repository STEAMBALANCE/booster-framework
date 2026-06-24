import { test, expect, beforeEach } from 'bun:test';
import { Window } from 'happy-dom';
import { createScope } from '../src/api/scope';

let win: Window;

// Register happy-dom Window as global window so scope.ts's `window.setTimeout`
// / `window.setInterval` references resolve to the per-test Window. Each test
// gets a fresh Window so timer state doesn't leak across cases.
beforeEach(() => {
  win = new Window();
  // @ts-expect-error - happy-dom Window assigned to globalThis.window
  globalThis.window = win;
});

// Wait `ms` real milliseconds. Centralising a bare `setTimeout` here keeps
// test bodies focused on what they're asserting.
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('signal.aborted flips false → true on _abort', () => {
  const scope = createScope();
  expect(scope.signal.aborted).toBe(false);
  scope._abort();
  expect(scope.signal.aborted).toBe(true);
});

test('setTimeout cb does NOT fire after _abort', async () => {
  const scope = createScope();
  let called = false;
  scope.setTimeout(() => { called = true; }, 20);
  scope._abort();
  await wait(60);
  expect(called).toBe(false);
});

test('setInterval cb stops firing after _abort', async () => {
  const scope = createScope();
  let count = 0;
  scope.setInterval(() => { count++; }, 10);
  // Let it fire at least once before we abort.
  await wait(35);
  const beforeAbort = count;
  expect(beforeAbort).toBeGreaterThan(0);
  scope._abort();
  await wait(50);
  expect(count).toBe(beforeAbort);
});

test('listen handler is removed on _abort (event after abort is ignored)', () => {
  const scope = createScope();
  const target = new EventTarget();
  let count = 0;
  scope.listen(target, 'ping', () => { count++; });
  target.dispatchEvent(new Event('ping'));
  expect(count).toBe(1);
  scope._abort();
  target.dispatchEvent(new Event('ping'));
  expect(count).toBe(1);
});

test('listen forwards opts.once (limit fires to a single event)', () => {
  // Indirect proof of opts pass-through via {once: true}. If listen
  // dropped opts on the floor, both dispatches below would invoke the
  // handler. We test only `once` because it has the cleanest
  // observable signal in happy-dom; `capture`/`passive` would require
  // a parent/child target pair and dispatchEvent uses bubbling-default
  // dispatch which doesn't exercise capture-phase regardless.
  const scope = createScope();
  const target = new EventTarget();
  let count = 0;
  scope.listen(target, 'ping', () => { count++; }, { once: true });
  target.dispatchEvent(new Event('ping'));
  target.dispatchEvent(new Event('ping'));
  expect(count).toBe(1);
});

test('observer.disconnect is called on _abort', () => {
  const scope = createScope();
  let disconnected = false;
  const obs = { disconnect: () => { disconnected = true; } };
  scope.observer(obs);
  expect(disconnected).toBe(false);
  scope._abort();
  expect(disconnected).toBe(true);
});

test('observer ignores throws from disconnect (defense)', () => {
  // A MutationObserver whose target node was already removed can throw
  // inside disconnect on some environments. Scope must swallow.
  const scope = createScope();
  const obs = { disconnect: () => { throw new Error('boom'); } };
  scope.observer(obs);
  expect(() => scope._abort()).not.toThrow();
});

test('abortable rejects with AbortError when signal aborts mid-flight', async () => {
  const scope = createScope();
  // A Promise that never resolves on its own — rejection has to come from
  // the abort path or the await would hang forever.
  const pending = new Promise<number>(() => { /* never */ });
  const wrapped = scope.abortable(pending);
  // Schedule the abort on a microtask so we exercise the addEventListener
  // path (rather than the fast-path early-return).
  queueMicrotask(() => scope._abort());
  let err: unknown = null;
  try {
    await wrapped;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DOMException);
  expect((err as DOMException).name).toBe('AbortError');
});

test('abortable rejects synchronously when scope already aborted (fast-path)', async () => {
  const scope = createScope();
  scope._abort();
  // Even though the inner Promise resolves cleanly, abortable's fast-path
  // must reject without subscribing.
  const wrapped = scope.abortable(Promise.resolve(42));
  let err: unknown = null;
  try {
    await wrapped;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DOMException);
  expect((err as DOMException).name).toBe('AbortError');
});

test('fetch rejects when scope already aborted', async () => {
  const scope = createScope();
  scope._abort();
  // 127.0.0.1:1 is a deliberately unreachable port — but with an aborted
  // signal, fetch rejects synchronously without attempting the network
  // call, so the unreachability doesn't matter and test runs fast.
  let err: unknown = null;
  try {
    await scope.fetch('http://127.0.0.1:1/never');
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  // Bun's fetch wraps abort as DOMException('AbortError'). We don't
  // overspecify the message — just that the error is non-null and the name
  // is AbortError.
  expect((err as DOMException).name).toBe('AbortError');
});

test('fetch composes user-provided signal via AbortSignal.any (user signal aborts → fetch rejects)', async () => {
  // Cover the AbortSignal.any compose path: caller passes their own
  // AbortController in init.signal, scope is alive. Aborting the user
  // signal must cancel the fetch even though the scope is still ok —
  // proves the merge actually wires both signals.
  const scope = createScope();
  const userCtrl = new AbortController();
  // Abort BEFORE fetch starts so the request rejects immediately and we
  // don't depend on an unreachable host's connect timeout.
  userCtrl.abort();
  let err: unknown = null;
  try {
    await scope.fetch('http://127.0.0.1:1/never', { signal: userCtrl.signal });
  } catch (e) {
    err = e;
  }
  expect((err as DOMException).name).toBe('AbortError');
  // Sanity: scope itself remains intact — the user-signal abort doesn't
  // leak into our scope.
  expect(scope.signal.aborted).toBe(false);
});

test('post-abort setTimeout returns sentinel -1 and does NOT fire', async () => {
  const scope = createScope();
  scope._abort();
  let called = false;
  const id = scope.setTimeout(() => { called = true; }, 5);
  expect(id).toBe(-1);
  await wait(30);
  expect(called).toBe(false);
});

test('post-abort setInterval returns sentinel -1 and does NOT fire', async () => {
  const scope = createScope();
  scope._abort();
  let count = 0;
  const id = scope.setInterval(() => { count++; }, 5);
  expect(id).toBe(-1);
  await wait(30);
  expect(count).toBe(0);
});

test('scope.clearTimeout cancels a scope.setTimeout before it fires', async () => {
  const scope = createScope();
  let called = false;
  const id = scope.setTimeout(() => { called = true; }, 20);
  scope.clearTimeout(id);
  await wait(50);
  expect(called).toBe(false);
});

test('scope.clearInterval stops a scope.setInterval', async () => {
  const scope = createScope();
  let count = 0;
  const id = scope.setInterval(() => { count++; }, 10);
  await wait(35);
  expect(count).toBeGreaterThan(0);
  scope.clearInterval(id);
  const beforeWait = count;
  await wait(40);
  expect(count).toBe(beforeWait);
});

test('post-abort observer.disconnect is called immediately', () => {
  // Without the explicit early-out, `addEventListener('abort', ...)` on an
  // already-aborted signal would silently no-op (per spec), leaving the
  // observer running forever after .observe(...). This test guards that
  // contract.
  const scope = createScope();
  scope._abort();
  let disconnected = false;
  const obs = { disconnect: () => { disconnected = true; } };
  scope.observer(obs);
  expect(disconnected).toBe(true);
});

test('createScope uses passed AbortController when provided', () => {
  const externalCtrl = new AbortController();
  const scope = createScope(externalCtrl);
  expect(scope.signal).toBe(externalCtrl.signal);
  expect(scope.signal.aborted).toBe(false);
  externalCtrl.abort();
  expect(scope.signal.aborted).toBe(true);
});

test('createScope creates own controller when no arg', () => {
  const scope = createScope();
  expect(scope.signal.aborted).toBe(false);
  // Cannot abort from outside since no controller is exposed — use _abort
  if ('_abort' in scope && typeof (scope as { _abort?: () => void })._abort === 'function') {
    (scope as { _abort: () => void })._abort();
    expect(scope.signal.aborted).toBe(true);
  }
});
