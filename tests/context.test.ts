import { describe, test, expect, beforeEach } from 'bun:test';
import { Window } from 'happy-dom';
import { makeContextApi } from '../src/api/context';
import { createScope } from '../src/api/scope';

// Install happy-dom DOM into globalThis so context.ts's window/history/location
// access works. Each test gets a fresh Window so history/listener state does
// not leak across cases (same precedent as scope.test.ts).
function installDom(initialUrl = 'https://example.test/test-base') {
  const w = new Window({ url: initialUrl });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    history: w.history,
    location: w.location,
    addEventListener: w.addEventListener.bind(w),
    removeEventListener: w.removeEventListener.bind(w),
  });
  return w;
}

describe('makeContextApi', () => {
  beforeEach(() => {
    installDom();
  });

  test('kind is read-only field from constructor arg', () => {
    const scope = createScope();
    const ctx = makeContextApi(scope, 'web');
    expect(ctx.kind).toBe('web');
  });

  test('url initialised to current location.href', () => {
    history.replaceState(null, '', '/foo?bar=1');
    const scope = createScope();
    const ctx = makeContextApi(scope, 'web');
    expect(ctx.url).toContain('/foo?bar=1');
  });

  test('pushState fires onUrlChange', async () => {
    const scope = createScope();
    const ctx = makeContextApi(scope, 'web');
    const received: string[] = [];
    ctx.onUrlChange(u => received.push(u));
    // skip initial-fire (microtask) before pushing
    await Promise.resolve();
    received.length = 0;
    history.pushState(null, '', '/new-url');
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(received.length).toBe(1);
    expect(received[0]).toContain('/new-url');
  });

  test('replaceState fires onUrlChange', async () => {
    const scope = createScope();
    const ctx = makeContextApi(scope, 'web');
    const received: string[] = [];
    ctx.onUrlChange(u => received.push(u));
    await Promise.resolve();
    received.length = 0;
    history.replaceState(null, '', '/replaced');
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(received.length).toBe(1);
    expect(received[0]).toContain('/replaced');
  });

  test('onUrlChange initial-fires with current url', async () => {
    history.replaceState(null, '', '/start');
    const scope = createScope();
    const ctx = makeContextApi(scope, 'web');
    const received: string[] = [];
    ctx.onUrlChange(u => received.push(u));
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toContain('/start');
  });

  test('scope._abort restores history.pushState', () => {
    const native = history.pushState;
    const scope = createScope();
    makeContextApi(scope, 'web');
    expect(history.pushState).not.toBe(native);
    scope._abort();
    expect(history.pushState).toBe(native);
  });

  test('cross-injection patch guard preserves native via __sb_native marker', () => {
    const native = history.pushState;
    const scope1 = createScope();
    makeContextApi(scope1, 'main');
    const scope2 = createScope();
    makeContextApi(scope2, 'main');
    scope2._abort();
    scope1._abort();
    // Now back to native.
    expect(history.pushState).toBe(native);
  });
});
