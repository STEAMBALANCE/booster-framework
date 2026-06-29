// B1 surface tests: frozen window.sb, frozen per-plugin wrappers, intrinsic capture.
//
// RED/GREEN split:
//   RED before B1 (tests 5-7): gated-view + wrapper freezing, intrinsic capture
//   Concept tests (1-4): document expected window.sb / __sb_internal shape;
//     these construct the facade themselves so they pass both before and after B1,
//     but they serve as a reference for the bootstrap implementation.

// createBridge() accesses window.__sb_resolve at call time; provide window
// before any test runs (same pattern as bridge.test.ts).
// @ts-expect-error
globalThis.window = globalThis;

import { test, expect } from 'bun:test';
import { buildGatedSb } from '../src/plugins/capability-gating';
import { createPluginConfigs } from '../src/plugins/configs';
import { createPluginUi } from '../src/plugins/ui';
import { createPluginBus } from '../src/plugins/bus';
import { createPluginLog } from '../src/plugins/log';
import { makeKeysApi } from '../src/api/keys';
import { createBridge } from '../src/bridge';
import { Capability, type SbApi } from '../src/api/api-types';

// ---------------------------------------------------------------------------
// Helper mock SbApi
// ---------------------------------------------------------------------------

function makeMockSb(): SbApi {
  return {
    version: '0.0.0',
    state: 'ready',
    context: {} as never,
    app: { getSetupId: async () => undefined },
    ui: { _real_ui: true } as never,
    steam: { _real_steam: true } as never,
    lifecycle: { rollbackAll: () => {}, ready: () => Promise.resolve() } as never,
    scope: {} as never,
    configs: {} as never,
    bus: { publish: () => {}, subscribe: () => () => {} } as never,
    pages: {} as never,
    plugins: { register: () => {}, ready: () => Promise.resolve() } as never,
    keys: {} as never,
  };
}

// ---------------------------------------------------------------------------
// Tests 1-4: window.sb + __sb_internal surface (concept tests, always green).
// These document the expected B1 behavior; they verify the frozen facade
// shape by constructing it directly, not by running the full bootstrap.
// ---------------------------------------------------------------------------

test('window.sb frozen minimal facade: only plugins.register (concept)', () => {
  const mockRegister = () => {};
  const facade = Object.freeze({ plugins: Object.freeze({ register: mockRegister }) });
  expect(Object.isFrozen(facade)).toBe(true);
  expect(Object.isFrozen((facade as { plugins: unknown }).plugins)).toBe(true);
  expect((facade as Record<string, unknown>).steam).toBeUndefined();
  expect((facade as Record<string, unknown>).ui).toBeUndefined();
  expect((facade as Record<string, unknown>).configs).toBeUndefined();
  expect((facade as Record<string, unknown>).bus).toBeUndefined();
  expect((facade as Record<string, unknown>).keys).toBeUndefined();
  expect((facade as Record<string, unknown>).pages).toBeUndefined();
  expect(typeof (facade as { plugins: { register: unknown } }).plugins.register).toBe('function');
});

test('window.sb frozen facade: assigning steam does not add property', () => {
  const facade = Object.freeze({ plugins: Object.freeze({ register: () => {} }) }) as Record<string, unknown>;
  // In strict mode (bun test runs strict) this throws TypeError; in sloppy it silently fails.
  // Either way the property must not be present afterward.
  try { facade.steam = {}; } catch { /* TypeError in strict — expected */ }
  expect(facade.steam).toBeUndefined();
});

test('__sb_internal carries rollbackAll and teardown (concept)', () => {
  let rollbackCalled = false;
  let teardownCalled = false;
  // Simulate what index.ts sets:
  const internal = {
    rollbackAll: () => { rollbackCalled = true; },
    teardown: () => { teardownCalled = true; },
  };
  // Simulate re-injection reading __sb_internal:
  if (internal) {
    internal.rollbackAll?.();
    internal.teardown?.();
  }
  expect(rollbackCalled).toBe(true);
  expect(teardownCalled).toBe(true);
});

test('re-injection reads __sb_internal instead of window.sb.lifecycle (concept)', () => {
  // Before B1: re-injection block reads window.sb.lifecycle.rollbackAll()
  // After B1: re-injection block reads window.__sb_internal.rollbackAll()
  // Verify that __sb_internal.rollbackAll is callable and represents the right hook.
  let called = false;
  const internal: { rollbackAll: () => void; teardown: () => void } = {
    rollbackAll: () => { called = true; },
    teardown: () => {},
  };
  // Guard pattern from index.ts (post-B1):
  if (internal) {
    try { internal.rollbackAll(); } catch { /* swallow */ }
  }
  expect(called).toBe(true);
});

test('re-injection falls back to legacy window.sb.lifecycle.rollbackAll when __sb_internal absent (concept)', () => {
  // Models the FIRST hot-update / self-update transition: the page is still
  // running the OLD (pre-this-branch) framework, which recorded its rollback
  // handle on window.sb.lifecycle and never set window.__sb_internal. The new
  // bootstrap must still roll back that old injection via the legacy handle.
  let called = false;
  const fakeWindow: {
    __sb_internal?: { rollbackAll: () => void };
    sb?: { lifecycle?: { rollbackAll?: () => void } };
  } = {
    sb: { lifecycle: { rollbackAll: () => { called = true; } } },
  };
  // Guard pattern from index.ts (Fix 1): prefer __sb_internal, fall back to
  // the legacy window.sb.lifecycle handle for the one-time transition.
  const legacyLifecycle = fakeWindow.sb?.lifecycle;
  if (fakeWindow.__sb_internal || typeof legacyLifecycle?.rollbackAll === 'function') {
    try {
      if (fakeWindow.__sb_internal) {
        fakeWindow.__sb_internal.rollbackAll();
      } else {
        legacyLifecycle!.rollbackAll!();
      }
    } catch { /* swallow */ }
  }
  expect(called).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 5: buildGatedSb result is frozen
// RED before B1 (capability-gating.ts doesn't freeze), GREEN after.
// ---------------------------------------------------------------------------

test('buildGatedSb result is frozen', () => {
  const gated = buildGatedSb(makeMockSb(), new Set([Capability.Ui]));
  expect(Object.isFrozen(gated)).toBe(true);
});

test('buildGatedSb frozen: assigning extra property throws in strict mode', () => {
  const gated = buildGatedSb(makeMockSb(), new Set([Capability.Ui])) as Record<string, unknown>;
  expect(() => { gated.extra = 'x'; }).toThrow();
});

test('buildGatedSb frozen: get state() getter still works after freeze', () => {
  const real = makeMockSb();
  const gated = buildGatedSb(real, new Set([Capability.Ui]));
  // Getter must still return the live value through the freeze.
  expect(gated.state).toBe('ready');
});

// ---------------------------------------------------------------------------
// Test 6: per-plugin wrappers are frozen
// RED before B1 (configs/ui/bus/log don't freeze), GREEN after.
// ---------------------------------------------------------------------------

test('createPluginConfigs result is frozen', () => {
  const fakeBridge = {
    call: async () => ({ data: null }),
    notify: () => {},
  } as never;
  const configs = createPluginConfigs(fakeBridge, 'booster-test');
  expect(Object.isFrozen(configs)).toBe(true);
});

test('createPluginConfigs frozen: assigning extra property throws in strict mode', () => {
  const fakeBridge = { call: async () => ({ data: null }), notify: () => {} } as never;
  const configs = createPluginConfigs(fakeBridge, 'booster-test') as Record<string, unknown>;
  expect(() => { configs.extra = 'x'; }).toThrow();
});

test('createPluginUi result is frozen', () => {
  const fakeUi = {
    addHeaderButton: () => ({} as never),
    attachPopup: async () => ({} as never),
    openWindow: async () => ({} as never),
    openExternalWindow: async () => ({} as never),
  } as never;
  const wrapped = createPluginUi(fakeUi, 'booster-test');
  expect(Object.isFrozen(wrapped)).toBe(true);
});

test('createPluginBus result is frozen', () => {
  const fakeBus = { publish: () => {}, subscribe: () => () => {} } as never;
  const ctrl = new AbortController();
  const wrapped = createPluginBus(fakeBus, 'booster-test', ctrl.signal);
  expect(Object.isFrozen(wrapped)).toBe(true);
});

test('createPluginLog result is frozen', () => {
  const log = createPluginLog('booster-test', () => {});
  expect(Object.isFrozen(log)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 7a: Intrinsic capture — BroadcastChannel
// RED before B1: makeKeysApi reads live globalThis.BroadcastChannel at call time
//   → spy is called when BC is replaced before the call.
// GREEN after B1: _BroadcastChannel captured at module-load time (before spy)
//   → spy is not called.
// ---------------------------------------------------------------------------

test('BroadcastChannel replacement after module load does not affect keys module', () => {
  const origBC = globalThis.BroadcastChannel;
  let spyCalled = false;

  // Capture undo function from registry so we can close the BC after the test.
  let undoFn: (() => void) | undefined;
  const fakeRegistry = {
    push: (entry: { undo: () => void }) => { undoFn = entry.undo; },
  } as never;

  try {
    // Replace BroadcastChannel AFTER module load.
    // (src/api/keys.ts was imported at the top of this file; its module-level
    // `const _BroadcastChannel = BroadcastChannel` ran at import time with origBC.)
    (globalThis as Record<string, unknown>).BroadcastChannel = function FakeBC(channel: string) {
      spyCalled = true;
      // Still create a real BC so the keys api works correctly.
      return new origBC(channel);
    };

    makeKeysApi(fakeRegistry);

    // Before B1: `new BroadcastChannel(...)` reads live global → spy called → FAIL
    // After B1: `new _BroadcastChannel(...)` uses captured original → spy not called → PASS
    expect(spyCalled).toBe(false);
  } finally {
    // Close the BroadcastChannel opened by makeKeysApi.
    try { undoFn?.(); } catch { /* ignore */ }
    (globalThis as Record<string, unknown>).BroadcastChannel = origBC;
  }
});

// ---------------------------------------------------------------------------
// Test 7b: Intrinsic capture — JSON.stringify
// RED before B1: bridge.notify calls JSON.stringify at call time → spy is called.
// GREEN after B1: _JSONStringify captured at module-load → spy is not called.
// ---------------------------------------------------------------------------

test('JSON.stringify replacement after module load does not affect bridge envelope building', () => {
  const origStringify = JSON.stringify;
  let spyCalled = false;

  try {
    // Replace JSON.stringify AFTER module load.
    // (src/bridge.ts was imported above; its module-level
    // `const _JSONStringify = JSON.stringify.bind(JSON)` ran at import time.)
    (JSON as Record<string, unknown>).stringify = (...args: unknown[]) => {
      spyCalled = true;
      return origStringify.apply(JSON, args as [unknown]);
    };

    const transport = { send: (_msg: string) => {} };
    const bridge = createBridge(transport);
    // notify is synchronous; call() would add a 10s timer — use notify instead.
    bridge.notify('test-op', 'test-plugin', { x: 1 });

    // Before B1: `JSON.stringify(env)` reads live JSON.stringify → spy called → FAIL
    // After B1: `_JSONStringify(env)` uses captured original → spy not called → PASS
    expect(spyCalled).toBe(false);
  } finally {
    (JSON as Record<string, unknown>).stringify = origStringify;
  }
});
