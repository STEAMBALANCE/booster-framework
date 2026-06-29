import { test, expect, describe, afterEach } from 'bun:test';
import { createRelayChannel, RELAY_SECRET_FIELD } from '../src/relay/channel';
import { RELAY_CHANNEL } from '../src/relay/protocol';

// 30ms is enough to flush BroadcastChannel dispatch within a single bun process.
const flushBC = () => new Promise<void>((r) => setTimeout(r, 30));

describe('createRelayChannel', () => {
  const toClose: BroadcastChannel[] = [];

  function track(ch: ReturnType<typeof createRelayChannel>) {
    toClose.push(ch.raw);
    return ch;
  }
  function trackRaw(bc: BroadcastChannel) {
    toClose.push(bc);
    return bc;
  }

  afterEach(() => {
    while (toClose.length) toClose.pop()!.close();
  });

  // ─── Tagged mode (secret='S') ──────────────────────────────────────────────

  test('post tags and onMessage strips the secret (roundtrip)', async () => {
    const chA = track(createRelayChannel('S'));
    const chB = track(createRelayChannel('S'));
    const received: unknown[] = [];
    chB.onMessage((data) => received.push(data));
    chA.post({ kind: 'x' });
    await flushBC();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ kind: 'x' });
    expect((received[0] as Record<string, unknown>)[RELAY_SECRET_FIELD]).toBeUndefined();
  });

  test('post carries __sbsec in the underlying postMessage', async () => {
    const rawListener = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const ch = track(createRelayChannel('S'));
    const rawMessages: unknown[] = [];
    rawListener.onmessage = (ev) => rawMessages.push(ev.data);
    ch.post({ kind: 'x' });
    await flushBC();
    expect(rawMessages).toHaveLength(1);
    expect(rawMessages[0]).toEqual({ kind: 'x', [RELAY_SECRET_FIELD]: 'S' });
  });

  test('onMessage drops inbound without secret', async () => {
    const chReceiver = track(createRelayChannel('S'));
    const rawSender = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const received: unknown[] = [];
    chReceiver.onMessage((data) => received.push(data));
    rawSender.postMessage({ kind: 'y' });
    await flushBC();
    expect(received).toHaveLength(0);
  });

  test('onMessage drops inbound with wrong secret', async () => {
    const chReceiver = track(createRelayChannel('S'));
    const rawSender = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const received: unknown[] = [];
    chReceiver.onMessage((data) => received.push(data));
    rawSender.postMessage({ kind: 'y', [RELAY_SECRET_FIELD]: 'wrong' });
    await flushBC();
    expect(received).toHaveLength(0);
  });

  test('onMessage delivers with tag stripped when secret matches', async () => {
    const chReceiver = track(createRelayChannel('S'));
    const rawSender = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const received: unknown[] = [];
    chReceiver.onMessage((data) => received.push(data));
    rawSender.postMessage({ kind: 'y', [RELAY_SECRET_FIELD]: 'S' });
    await flushBC();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ kind: 'y' });
    expect((received[0] as Record<string, unknown>)[RELAY_SECRET_FIELD]).toBeUndefined();
  });

  // ─── Untagged mode (secret=undefined) ─────────────────────────────────────

  test('secret=undefined posts without tag', async () => {
    const rawListener = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const ch = track(createRelayChannel(undefined));
    const rawMessages: unknown[] = [];
    rawListener.onmessage = (ev) => rawMessages.push(ev.data);
    ch.post({ kind: 'z' });
    await flushBC();
    expect(rawMessages).toHaveLength(1);
    expect(rawMessages[0]).toEqual({ kind: 'z' });
    expect((rawMessages[0] as Record<string, unknown>)[RELAY_SECRET_FIELD]).toBeUndefined();
  });

  test('secret=undefined delivers all inbound without filtering', async () => {
    const chReceiver = track(createRelayChannel(undefined));
    const rawSender = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const received: unknown[] = [];
    chReceiver.onMessage((data) => received.push(data));
    rawSender.postMessage({ kind: 'z' });
    await flushBC();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ kind: 'z' });
  });

  test('secret=undefined delivers tagged inbound unmodified (back-compat)', async () => {
    const chReceiver = track(createRelayChannel(undefined));
    const rawSender = trackRaw(new BroadcastChannel(RELAY_CHANNEL));
    const received: unknown[] = [];
    chReceiver.onMessage((data) => received.push(data));
    rawSender.postMessage({ kind: 'z', [RELAY_SECRET_FIELD]: 'any' });
    await flushBC();
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>)[RELAY_SECRET_FIELD]).toBe('any');
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  test('onMessage returns unsubscribe fn that stops further delivery', async () => {
    const chA = track(createRelayChannel('S'));
    const chB = track(createRelayChannel('S'));
    const received: unknown[] = [];
    const unsub = chB.onMessage((data) => received.push(data));
    chA.post({ kind: 'x' });
    await flushBC();
    expect(received).toHaveLength(1);
    unsub();
    chA.post({ kind: 'x' });
    await flushBC();
    expect(received).toHaveLength(1); // no new delivery after unsub
  });

  test('post() does not mutate the caller object', () => {
    const ch = track(createRelayChannel('S'));
    const o = { kind: 'x' };
    ch.post(o);
    expect(o['__sbsec' as keyof typeof o]).toBeUndefined();
  });

  test('close() closes the raw BroadcastChannel without throwing', () => {
    const ch = track(createRelayChannel('S'));
    expect(() => ch.close()).not.toThrow();
    // raw is still accessible after close (just closed)
    expect(ch.raw).toBeDefined();
  });

  test('raw is a BroadcastChannel on RELAY_CHANNEL', () => {
    const ch = track(createRelayChannel('S'));
    expect(ch.raw).toBeInstanceOf(BroadcastChannel);
    expect(ch.raw.name).toBe(RELAY_CHANNEL);
  });
});
