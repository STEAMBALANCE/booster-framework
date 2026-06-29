import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createScope } from '../src/api/scope';

// relay-resolver-name.test.ts
//
// Asserts that startRelay wires sec.resolverName through to createBridge so
// the relay-side bridge registers its promise resolver under the per-launch
// secret name, NOT the hardcoded `window.__sb_resolve`.
//
// createBridge registers the resolver on `window` non-enumerably at
// construction time, so we can check the property descriptor on the
// happy-dom Window immediately after calling startRelay — no async BC
// dispatch needed.

let win: Window;
let stopRelay: (() => void) | null = null;

beforeEach(() => {
  win = new Window();
  // happy-dom 20 doesn't populate window.SyntaxError; patch so relay imports
  // that touch SyntaxError don't throw in the test realm.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error — happy-dom Window assigned to globalThis.window so
  // bridge.ts's `Object.defineProperty(window, ...)` targets the test window.
  globalThis.window = win;
  // Minimal SteamClient stub — installPushUserChangeListener reads optional
  // fields via SteamClient?.User?.RegisterForCurrentUserChanges?.().
  // @ts-expect-error
  globalThis.SteamClient = {};
  (win as unknown as { SteamClient: unknown }).SteamClient = {};
  // Leave MainWindowBrowserManager absent → mwbmStore is undefined →
  // setupExternalWindowRelay is skipped (no MWBM mock needed).
});

afterEach(() => {
  if (stopRelay) {
    stopRelay();
    stopRelay = null;
  }
  // Clean up any resolver globals the test may have registered.
  for (const name of ['sb_relaytest', 'sb_relaytest2', '__sb_resolve']) {
    try { delete (win as any)[name]; } catch { /* */ }
  }
  delete (win as any).__sb_relay_started;
  delete (win as any).__sb_relay_teardown;
});

test('relay: startRelay registers non-enumerable secret resolver from sec.resolverName', async () => {
  // Dynamic import returns the cached module (BroadcastChannel captured at
  // first import via Bun's native global BC — same pattern as relay.test.ts).
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope(), { resolverName: 'sb_relaytest' });

  // createBridge(undefined, { resolverName: 'sb_relaytest' }) registers the
  // resolver on `window` non-enumerably (B5 contract).
  const desc = Object.getOwnPropertyDescriptor(win, 'sb_relaytest');
  expect(desc).toBeDefined();
  expect(desc!.enumerable).toBe(false);
  expect(typeof (win as any)['sb_relaytest']).toBe('function');
  // The legacy global must NOT be registered when a secret name is provided.
  expect(Object.getOwnPropertyDescriptor(win, '__sb_resolve')).toBeUndefined();
});

test('relay: startRelay without resolverName falls back to window.__sb_resolve', async () => {
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope(), undefined);

  const desc = Object.getOwnPropertyDescriptor(win, '__sb_resolve');
  expect(desc).toBeDefined();
  expect(typeof (win as any)['__sb_resolve']).toBe('function');
});
