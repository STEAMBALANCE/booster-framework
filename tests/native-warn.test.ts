// [framework] nativeWarn — calls __sb_native with correct shape, swallows
// when __sb_native is absent.
//
// nativeWarn reads window.__sb_native at call time (not at import time), so
// tests manage presence per-test via beforeEach/afterEach.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Provide a minimal window global so nativeWarn can reach window.__sb_native.
// @ts-expect-error
globalThis.window = globalThis;

import { nativeWarn } from '../src/native-warn';

describe('nativeWarn', () => {
  let originalNative: ((s: string) => void) | undefined;

  beforeEach(() => {
    originalNative = (globalThis as any).__sb_native;
  });
  afterEach(() => {
    (globalThis as any).__sb_native = originalNative;
  });

  test('sends a notify envelope the C++ log op accepts', () => {
    let captured: any = null;
    (globalThis as any).__sb_native = (s: string) => { captured = JSON.parse(s); };

    nativeWarn('something went wrong', { detail: 'x' });

    expect(captured).not.toBeNull();
    expect(captured.op).toBe('log');
    // Fire-and-forget envelope: notify kind, valid pluginId, no requestId.
    expect(captured.kind).toBe('notify');
    expect(captured.pluginId).toBe('booster-framework');
    expect(captured.requestId).toBeUndefined();
    // log op reads args.level / args.msg / args.meta.
    expect(captured.args.level).toBe('warn');
    expect(captured.args.msg).toBe('something went wrong');
    expect(captured.args.meta).toEqual({ detail: 'x' });
  });

  test('silently swallows when __sb_native is undefined — no throw', () => {
    delete (globalThis as any).__sb_native;
    // Must not throw even though the bridge is absent.
    expect(() => nativeWarn('no bridge here')).not.toThrow();
  });
});
