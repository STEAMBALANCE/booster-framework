import { test, expect } from 'bun:test';
import { createPluginBus } from '../src/plugins/bus';

interface PublishCall { topic: string; data: unknown }
interface SubCall { topic: string; cb: (data: unknown) => void }

function makeMockBus(): { publishes: PublishCall[]; subscribes: SubCall[]; unsubscribed: number; publish: (t: string, d?: unknown) => void; subscribe: (t: string, cb: (d: unknown) => void) => () => void } {
  const mock = {
    publishes: [] as PublishCall[],
    subscribes: [] as SubCall[],
    unsubscribed: 0,
    publish: (t: string, d?: unknown) => { mock.publishes.push({ topic: t, data: d }); },
    subscribe: (t: string, cb: (d: unknown) => void): (() => void) => {
      mock.subscribes.push({ topic: t, cb });
      return () => { mock.unsubscribed++; };
    },
  };
  return mock;
}

test('publish from booster-test rejects non-prefixed topic', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  expect(() => wrapped.publish('foo.bar', {})).toThrow(/must start with 'booster-test\.'/);
});

test('publish accepts exact pluginId prefix with dot separator', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  expect(() => wrapped.publish('booster-test.foo', {})).not.toThrow();
  expect(realBus.publishes).toEqual([{ topic: 'booster-test.foo', data: {} }]);
});

test('publish rejects topic that shares prefix but no dot separator', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  expect(() => wrapped.publish('booster-test-foo.bar', {})).toThrow(/must start with/);
});

test('subscribe to own-prefix allowed with empty subscribeTopics', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  expect(() => wrapped.subscribe('booster-test.topic', () => {})).not.toThrow();
  expect(realBus.subscribes).toHaveLength(1);
});

test('subscribe to undeclared foreign topic throws', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  expect(() => wrapped.subscribe('other.topic', () => {})).toThrow(/not allowed/);
});

test('subscribe to declared foreign exact topic is allowed', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, ['other-plugin.event']);
  expect(() => wrapped.subscribe('other-plugin.event', () => {})).not.toThrow();
  expect(realBus.subscribes).toHaveLength(1);
});

test('subscribe to declared foreign glob prefix is allowed (exact prefix and sub-topics)', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, ['other-plugin.*']);
  // sub-topic match
  expect(() => wrapped.subscribe('other-plugin.event', () => {})).not.toThrow();
  // exact prefix match
  expect(() => wrapped.subscribe('other-plugin', () => {})).not.toThrow();
  expect(realBus.subscribes).toHaveLength(2);
});

test('subscribe to undeclared foreign topic throws even with some subscribeTopics', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, ['other-plugin.event']);
  expect(() => wrapped.subscribe('third-plugin.event', () => {})).toThrow(/not allowed/);
});

test('subscribe auto-cleans on scope abort', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  wrapped.subscribe('booster-test.foo', () => {});
  expect(realBus.unsubscribed).toBe(0);
  ctrl.abort();
  expect(realBus.unsubscribed).toBe(1);
});

test('subscribe on already-aborted signal returns no-op unsub immediately', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  ctrl.abort();
  const wrapped = createPluginBus(realBus, 'booster-test', ctrl.signal, []);
  const unsub = wrapped.subscribe('booster-test.foo', () => {});
  expect(realBus.unsubscribed).toBe(1);  // unsub'd by createPluginBus immediately
  unsub();  // no-op
  expect(realBus.unsubscribed).toBe(1);  // still 1
});

test('manual unsubscribe removes the abort listener (net 0 leaked listeners)', () => {
  const realBus = makeMockBus();
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  // Count abort listeners net of removals by wrapping add/removeEventListener.
  let live = 0;
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  (signal as unknown as { addEventListener: typeof signal.addEventListener }).addEventListener =
    ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') live++;
      return (realAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof signal.addEventListener;
  (signal as unknown as { removeEventListener: typeof signal.removeEventListener }).removeEventListener =
    ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') live--;
      return (realRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof signal.removeEventListener;

  const wrapped = createPluginBus(realBus, 'booster-test', signal, []);
  const N = 5;
  for (let i = 0; i < N; i++) {
    const unsub = wrapped.subscribe(`booster-test.topic${i}`, () => {});
    unsub();
  }
  expect(realBus.unsubscribed).toBe(N);  // each subscription torn down
  expect(live).toBe(0);  // no abort listeners accumulated on the scope signal
});
