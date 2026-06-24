import { describe, test, expect } from 'bun:test';
import { makeBusApi } from '../src/api/bus';
import { createScope } from '../src/api/scope';
import type { Bridge } from '../src/bridge';

function fakeBridge(): Bridge & { calls: Array<{op: string; args: any}> } {
  const calls: Array<{op: string; args: any}> = [];
  return {
    calls,
    call: async (op, args) => { calls.push({op, args: args ?? {}}); return undefined; },
  } as any;
}

describe('makeBusApi', () => {
  test('publish dispatches via bridge.call', async () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    bus.publish('topic.x', { v: 1 });
    await new Promise(r => setTimeout(r, 5));
    expect(bridge.calls.length).toBe(1);
    expect(bridge.calls[0].op).toBe('bus.publish');
    expect(bridge.calls[0].args.topic).toBe('topic.x');
    expect(bridge.calls[0].args.data).toEqual({ v: 1 });
    scope._abort();
  });

  test('subscribe dispatches via __sb_bus_dispatch', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    const received: any[] = [];
    bus.subscribe('topic.x', (d) => received.push(d));
    (globalThis as any).__sb_bus_dispatch('topic.x', { v: 42 });
    expect(received).toEqual([{ v: 42 }]);
    scope._abort();
  });

  test('multiple subscribers same topic all fire', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    let a = 0, b = 0;
    bus.subscribe('t', () => a++);
    bus.subscribe('t', () => b++);
    (globalThis as any).__sb_bus_dispatch('t', {});
    expect(a).toBe(1);
    expect(b).toBe(1);
    scope._abort();
  });

  test('unsubscribe stops dispatch', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    let n = 0;
    const unsub = bus.subscribe('t', () => n++);
    (globalThis as any).__sb_bus_dispatch('t', {});
    unsub();
    (globalThis as any).__sb_bus_dispatch('t', {});
    expect(n).toBe(1);
    scope._abort();
  });

  test('invalid topic throws sync', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    expect(() => bus.publish('BAD', {})).toThrow(/invalid topic/);
    expect(() => bus.publish('', {})).toThrow(/invalid topic/);
    expect(() => bus.publish('1leading-digit', {})).toThrow(/invalid topic/);
    expect(() => bus.subscribe('BAD', () => {})).toThrow(/invalid topic/);
    scope._abort();
  });

  test('payload >16KB throws sync', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    const big = 'x'.repeat(17 * 1024);
    expect(() => bus.publish('t', { big })).toThrow(/payload too large/);
    scope._abort();
  });

  test('payload size check counts UTF-8 bytes, not UTF-16 code units', () => {
    // Cyrillic chars are 1 UTF-16 code unit each but 2 UTF-8 bytes.
    // Construct a payload that fits under 16 KB by .length but exceeds it
    // by .byteLength. With the prior `.length` check, this would slip
    // past the TS guard and trip the C++ guard with a confusing error.
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    // 10000 Cyrillic chars → 10000 UTF-16 code units, 20000 UTF-8 bytes
    // → throws under the byte check (20000 > 16384), passes under length.
    const cyrillic = 'я'.repeat(10000);  // strings-allow-cyrillic
    expect(() => bus.publish('t', { cyrillic })).toThrow(/payload too large/);
    scope._abort();
  });

  test('non-serializable data throws sync', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    const a: any = {}; a.self = a;
    expect(() => bus.publish('t', a)).toThrow(/JSON-serializable/);
    scope._abort();
  });

  test('scope._abort clears subscribers', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    let n = 0;
    bus.subscribe('t', () => n++);
    scope._abort();
    (globalThis as any).__sb_bus_dispatch?.('t', {});
    expect(n).toBe(0);
  });

  test('subscribe throws TypeError when cb is not a function', () => {
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    expect(() => bus.subscribe('t', null as unknown as () => void))
      .toThrow(TypeError);
    expect(() => bus.subscribe('t', undefined as unknown as () => void))
      .toThrow(TypeError);
    expect(() => bus.subscribe('t', 42 as unknown as () => void))
      .toThrow(/cb must be a function/);
    expect(() => bus.subscribe('t', 'cb' as unknown as () => void))
      .toThrow(/cb must be a function/);
    scope._abort();
  });

  test('subscriber that throws is logged via console.error and does not starve siblings', () => {
    // Pre-2026-05-21: thrown errors were silently swallowed (`// swallow`
    // comment in dispatch loop). I-2/I-5 from the phase-04 code review:
    // silent swallow makes a faulty subscriber an invisible failure mode.
    // Contract now: log via console.error AND continue dispatching to
    // other subscribers on the same topic (the second cb in this test
    // must still see the data even though the first one threw).
    const bridge = fakeBridge();
    const scope = createScope();
    const bus = makeBusApi(scope, bridge);
    const seenBySecond: unknown[] = [];
    bus.subscribe('t', () => { throw new Error('boom'); });
    bus.subscribe('t', (d) => { seenBySecond.push(d); });

    const origError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      (globalThis as any).__sb_bus_dispatch('t', { ok: true });
    } finally {
      console.error = origError;
    }

    // First subscriber threw → console.error captured the error.
    expect(errors.length).toBe(1);
    expect(String(errors[0]?.[0])).toContain("subscriber threw for topic 't'");
    // Second subscriber still ran — no starvation.
    expect(seenBySecond).toEqual([{ ok: true }]);
    scope._abort();
  });

  test('dispatch on unmatched topic warns in dev (S-2 dev-only diagnostic)', () => {
    // The dev-warn routes through `nativeWarn` (NOT console.warn) so it
    // surfaces in the C++ log sink even when DevTools is closed — matches
    // the established pattern in framework/src/relay/*.ts. Test mocks
    // window.__sb_native (the IPC primitive nativeWarn calls) to observe
    // the warn. Code-review S-4 from 2026-05-21 switched from
    // console.warn to nativeWarn here.
    const bridge = fakeBridge();
    const scope = createScope();
    makeBusApi(scope, bridge);
    const origNative = (window as unknown as { __sb_native?: unknown }).__sb_native;
    const nativeCalls: string[] = [];
    (window as unknown as { __sb_native?: (s: string) => void }).__sb_native =
      (s: string) => { nativeCalls.push(s); };
    try {
      (globalThis as any).__sb_bus_dispatch('never-subscribed-topic', {});
    } finally {
      (window as unknown as { __sb_native?: unknown }).__sb_native = origNative;
    }
    expect(nativeCalls.length).toBe(1);
    const payload = JSON.parse(nativeCalls[0]!);
    expect(payload.op).toBe('log');
    expect(payload.kind).toBe('notify');
    expect(payload.pluginId).toBe('booster-framework');
    expect(payload.args.level).toBe('warn');
    expect(String(payload.args.msg)).toContain('unmatched topic');
    expect(String(payload.args.msg)).toContain('never-subscribed-topic');
    scope._abort();
  });
});
