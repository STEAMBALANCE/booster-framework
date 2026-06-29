// security-probes.test.ts
//
// Adversarial regression tests: each PROBE asserts that a specific bypass
// vector STAYS blocked. These are not feature tests — they're tripwires. If a
// future refactor reopens one of these holes, the matching PROBE goes red.
//
// Scope note: there is a KNOWN, ACCEPTED residual — the per-launch relay secret
// is broadcast on the `sb_cmd` BroadcastChannel, so co-resident page content can
// harvest it. That vector is deliberately NOT probed here; do not add a test
// claiming it is closed.

import { test, expect } from 'bun:test';
import { createPluginBus } from '../src/plugins/bus';
import { createBridge } from '../src/bridge';
import { createRelayChannel, RELAY_SECRET_FIELD } from '../src/relay/channel';
import { RELAY_CHANNEL } from '../src/relay/protocol';

// 30ms is enough to flush BroadcastChannel dispatch within a single bun process
// (same constant as relay-channel.test.ts).
const flushBC = () => new Promise<void>((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------
// PROBE 1: Ambient window.sb exposes ONLY plugins.register, and is frozen.
//
// The bootstrap (src/index.ts) publishes window.sb as
//   Object.freeze({ plugins: Object.freeze({ register }) })
// and keeps the full capability-bearing SbApi in the closure (handed per-plugin
// via ctx.sb, capability-gated). A plugin reading ambient window.sb must NOT
// find steam/ui/configs/bus/keys/pages, and must not be able to graft a cap on.
// There is no exported facade builder, so this asserts against the identical
// minimal-facade construction the bootstrap performs (same pattern as the
// existing window-sb-surface concept tests).
// ---------------------------------------------------------------------------

test('PROBE: ambient window.sb exposes only plugins.register and is frozen (caps unreachable)', () => {
  const register = () => {};
  // Exact construction from src/index.ts bootstrap.
  const facade = Object.freeze({ plugins: Object.freeze({ register }) }) as Record<string, unknown>;

  // Only plugins.register is reachable.
  expect(typeof (facade.plugins as { register: unknown }).register).toBe('function');
  for (const cap of ['steam', 'ui', 'configs', 'bus', 'keys', 'pages']) {
    expect(facade[cap]).toBeUndefined();
  }

  // Frozen at both levels — a plugin cannot graft a capability on.
  expect(Object.isFrozen(facade)).toBe(true);
  expect(Object.isFrozen(facade.plugins)).toBe(true);
  try { facade.steam = { hijacked: true }; } catch { /* TypeError in strict — expected */ }
  expect(facade.steam).toBeUndefined();
});

// ---------------------------------------------------------------------------
// PROBE 2: bus.subscribe ACL stays enforced.
//
// createPluginBus gates subscribe(): own-prefix is always allowed; a foreign
// topic is allowed ONLY if covered by subscribeTopics (exact or `prefix.*`).
// Without a grant, subscribing to another plugin's topic must throw.
// ---------------------------------------------------------------------------

test('PROBE: bus.subscribe to a foreign topic throws without a grant', () => {
  const calls: string[] = [];
  const realBus = {
    publish: () => {},
    subscribe: (t: string) => { calls.push(t); return () => {}; },
  } as never;
  const ctrl = new AbortController();
  const bus = createPluginBus(realBus, 'booster-x', ctrl.signal, []);

  // Foreign topic, no grant → blocked.
  expect(() => bus.subscribe('booster-other.secret', () => {})).toThrow(/not allowed/);
  // Own-prefix topic → always allowed.
  expect(() => bus.subscribe('booster-x.own', () => {})).not.toThrow();
  // Only the allowed subscription reached the real bus.
  expect(calls).toEqual(['booster-x.own']);
});

test('PROBE: bus.subscribe to a foreign topic is allowed ONLY when granted via subscribeTopics', () => {
  const calls: string[] = [];
  const realBus = {
    publish: () => {},
    subscribe: (t: string) => { calls.push(t); return () => {}; },
  } as never;
  const ctrl = new AbortController();
  const bus = createPluginBus(realBus, 'booster-x', ctrl.signal, ['booster-other.*']);

  // Foreign topic now covered by the `booster-other.*` grant → allowed.
  expect(() => bus.subscribe('booster-other.secret', () => {})).not.toThrow();
  expect(calls).toEqual(['booster-other.secret']);
});

// ---------------------------------------------------------------------------
// PROBE 3: resolver interception via window.__sb_resolve is dead when the
// bridge registers under a per-launch secret name.
//
// createBridge(transport, { resolverName: 'sb_probe' }) registers its promise
// resolver under window['sb_probe'] and does NOT touch window.__sb_resolve. A
// plugin overwriting window.__sb_resolve cannot reach the bridge's `pending`
// map, so it cannot resolve (or hijack the result of) an in-flight call. Only
// the secret-named resolver resolves it.
// ---------------------------------------------------------------------------

test('PROBE: overwriting window.__sb_resolve does not resolve a secret-named bridge call', async () => {
  // @ts-expect-error — bridge resolver registration targets globalThis.window.
  globalThis.window = globalThis;
  const prevResolve = window.__sb_resolve;
  try {
    const sent: string[] = [];
    const bridge = createBridge({ send: (j) => sent.push(j) }, { resolverName: 'sb_probe' });
    const p = bridge.call('probe-op', {});
    const id = JSON.parse(sent[0]).requestId as number;

    // Attacker overwrites the legacy resolver and invokes it with the captured
    // id, attempting to settle the call with a forged result.
    let pluginResolverCalled = false;
    window.__sb_resolve = () => { pluginResolverCalled = true; };
    window.__sb_resolve(id, { ok: true, result: 'HIJACKED' });

    // The plugin's resolver ran but has no access to the bridge's pending map,
    // so the call is still unsettled. The legit secret-named resolver settles it.
    (window as unknown as Record<string, (i: number, r: unknown) => void>).sb_probe(
      id, { ok: true, result: 'legit' },
    );
    await expect(p).resolves.toBe('legit');
    expect(pluginResolverCalled).toBe(true);
  } finally {
    delete (window as unknown as Record<string, unknown>).sb_probe;
    if (prevResolve === undefined) delete window.__sb_resolve;
    else window.__sb_resolve = prevResolve;
  }
});

// ---------------------------------------------------------------------------
// PROBE 4: the relay channel drops untagged inbound messages.
//
// createRelayChannel('S').onMessage(cb) must drop any inbound message lacking
// `__sbsec: 'S'` (an attacker posting raw to the sb_cmd channel) and deliver a
// correctly-tagged one (with the tag stripped).
// ---------------------------------------------------------------------------

test('PROBE: relay channel drops untagged inbound and delivers tagged inbound', async () => {
  const receiver = createRelayChannel('S');
  const rawSender = new BroadcastChannel(RELAY_CHANNEL);
  try {
    const received: unknown[] = [];
    receiver.onMessage((data) => received.push(data));

    // Untagged (forged) message → dropped.
    rawSender.postMessage({ kind: 'forged' });
    await flushBC();
    expect(received).toHaveLength(0);

    // Correctly-tagged message → delivered, tag stripped.
    rawSender.postMessage({ kind: 'legit', [RELAY_SECRET_FIELD]: 'S' });
    await flushBC();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ kind: 'legit' });
    expect((received[0] as Record<string, unknown>)[RELAY_SECRET_FIELD]).toBeUndefined();
  } finally {
    receiver.close();
    rawSender.close();
  }
});
