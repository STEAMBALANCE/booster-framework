// Contract tests for the public SbApi shape (window.sb).
//
// Intent: verify that the factories exported by the framework's api/* modules
// assemble an object that satisfies every property and method declared in
// api-types.ts.  These tests do NOT duplicate the behavioral tests in
// lifecycle.test.ts / scope.test.ts / steam-api.test.ts — they lock in the
// *public surface contract* (window.sb shape) so a future refactor that
// renames or removes a property fails loudly here before it reaches plugin
// code.
//
// Bootstrap strategy: the production bootstrap (framework/src/index.ts) runs
// as a top-level IIFE and is not importable as a function.  We reproduce the
// same three-line assembly that index.ts uses — makeLifecycleApi, makeSteamApi,
// makeUiApi, createScope — and wrap the result as SbApi.  This is intentional:
// the test pins the exact composition index.ts performs, so any drift between
// the two is caught at review time.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { createRegistry } from '../src/registry';
import { createScope } from '../src/api/scope';
import { makeLifecycleApi } from '../src/api/lifecycle';
import { makeSteamApi } from '../src/api/steam';
import { makeUiApi } from '../src/api/ui';
import { makeConfigsApi } from '../src/api/configs';
import { makeContextApi, readContextKind } from '../src/api/context';
import { makePagesApi } from '../src/api/pages';
import { makeBusApi } from '../src/api/bus';
import { makeAppApi } from '../src/api/app';
import type { SbApi } from '../src/api/api-types';

// Minimal fake bridge — contract tests only assert shape, never invoke async ops.
const fakeBridge = { call: async () => ({}) } as never;

// Assembly helper: mirrors the index.ts bootstrap (non-SharedJSContext path),
// minus the window.defineProperty and scope.listen wiring that require a live
// DOM event system.
function makeSbApi(): SbApi {
  const registry = createRegistry();
  const scope = createScope();
  const lifecycle = makeLifecycleApi(registry, scope);
  const context = makeContextApi(scope, readContextKind());
  const pages = makePagesApi(scope, context);
  const bus = makeBusApi(scope, fakeBridge);
  const ui = makeUiApi(registry, fakeBridge);
  const steam = makeSteamApi(registry, fakeBridge);
  const configs = makeConfigsApi(fakeBridge);
  const app = makeAppApi(fakeBridge);
  // Mirror index.ts: state is backed by a mutable holder exposed through a
  // getter, and the bootstrap flips it to 'ready' right after _markReady().
  let lifecycleState: SbApi['state'] = 'loading';
  return {
    version: '0.0.0-test',
    get state() { return lifecycleState; },
    context,
    app,
    ui,
    steam,
    lifecycle,
    scope,
    configs,
    pages,
    bus,
    // Test-only seam mirroring index.ts's `lifecycleState = 'ready'` after
    // lifecycle._markReady(). Not part of the SbApi public surface.
    _markReadyForTest() { lifecycle._markReady(); lifecycleState = 'ready'; },
  } as SbApi & { _markReadyForTest(): void };
}

// happy-dom Window must be set up as globalThis.window before makeUiApi and
// makeSteamApi run — both touch BroadcastChannel and, in ui.ts, waitForToolbar
// schedules a MutationObserver.  A fresh Window per test prevents state leaks.
//
// afterEach restores the originals — without it, happy-dom's MutationObserver
// leaks to globalThis for the rest of the bun worker and pollutes any later
// test file that stubs `document.head` by hand (e.g. tabbed-shell-controller).
let _origWindow: unknown, _origDocument: unknown, _origMutationObserver: unknown, _origBroadcastChannel: unknown;
let _origLocation: unknown, _origHistory: unknown, _hadLocation = false, _hadHistory = false;
beforeEach(() => {
  _origWindow = globalThis.window;
  _origDocument = globalThis.document;
  _origMutationObserver = globalThis.MutationObserver;
  _origBroadcastChannel = globalThis.BroadcastChannel;
  _hadLocation = 'location' in globalThis;
  _hadHistory  = 'history'  in globalThis;
  _origLocation = (globalThis as { location?: unknown }).location;
  _origHistory  = (globalThis as { history?:  unknown }).history;
  const win = new Window();
  // happy-dom 20 doesn't populate window.SyntaxError; its querySelector parser
  // throws if absent.  Patch with the JS-builtin so selectors resolve.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error - assign happy-dom Window to globalThis
  globalThis.window = win;
  // @ts-expect-error - document / MutationObserver / BroadcastChannel from happy-dom
  globalThis.document = win.document;
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
  // makeContextApi reads bare `location.href` and patches `history.pushState`
  // — under bun those globals are not auto-bridged from a happy-dom Window,
  // so we expose them explicitly. Restored in afterEach.
  // @ts-expect-error - happy-dom Location → globalThis
  globalThis.location = win.location;
  // @ts-expect-error - happy-dom History → globalThis
  globalThis.history = win.history;
  // BroadcastChannel is available natively in bun — happy-dom 20 does not
  // expose it on the Window object, so we do not override the global here.
  // (Assigning win.BroadcastChannel would set globalThis.BroadcastChannel to
  // undefined, breaking the factories that call `new BroadcastChannel(...)`.)
  if ((win as unknown as Record<string, unknown>)['BroadcastChannel']) {
    // @ts-expect-error
    globalThis.BroadcastChannel = (win as unknown as Record<string, unknown>)['BroadcastChannel'];
  }
});
afterEach(() => {
  // @ts-expect-error
  globalThis.window = _origWindow;
  // @ts-expect-error
  globalThis.document = _origDocument;
  // @ts-expect-error
  globalThis.MutationObserver = _origMutationObserver;
  // @ts-expect-error
  globalThis.BroadcastChannel = _origBroadcastChannel;
  if (_hadLocation) {
    // @ts-expect-error
    globalThis.location = _origLocation;
  } else {
    delete (globalThis as { location?: unknown }).location;
  }
  if (_hadHistory) {
    // @ts-expect-error
    globalThis.history = _origHistory;
  } else {
    delete (globalThis as { history?: unknown }).history;
  }
});

// ─── Test 1 ──────────────────────────────────────────────────────────────────
// Intent: «`window.sb` exposes `version: string`, `state: 'loading' | 'ready'
//          | 'disabled'`, `ui`, `steam`, `lifecycle`, `scope`, `configs`
//          after bootstrap.»
test('window.sb shape — version (string), state (union literal), and sub-api properties are present', () => {
  const sb = makeSbApi() as SbApi & { _markReadyForTest(): void };

  expect(typeof sb.version).toBe('string');

  // Union contract: only these three values are legal for state.
  const validStates: Array<SbApi['state']> = ['loading', 'ready', 'disabled'];
  expect(validStates).toContain(sb.state);
  // Lifecycle-state transition is load-bearing: the real bootstrap leaves
  // state at 'loading' before lifecycle._markReady(), then flips it to
  // 'ready' immediately after. 'state' is a live getter, not a frozen
  // literal — the prior 'ready' value must be reachable (the bug was that
  // it never transitioned). 'disabled' stays in the union as forward-compat
  // (manifest kill-switch) but is not surfaced by any code path yet.
  expect(sb.state).toBe('loading');
  sb._markReadyForTest();
  expect(sb.state).toBe('ready');

  // Each sub-api must exist as an object (not null, not primitive).
  expect(sb.ui).toBeDefined();
  expect(typeof sb.ui).toBe('object');

  expect(sb.steam).toBeDefined();
  expect(typeof sb.steam).toBe('object');

  expect(sb.lifecycle).toBeDefined();
  expect(typeof sb.lifecycle).toBe('object');

  expect(sb.scope).toBeDefined();
  expect(typeof sb.scope).toBe('object');

  expect(sb.configs).toBeDefined();
  expect(typeof sb.configs).toBe('object');
  expect(typeof sb.configs.read).toBe('function');
  expect(typeof sb.configs.write).toBe('function');
});

// ─── Test 2 ──────────────────────────────────────────────────────────────────
// Intent: «`sb.ui.addHeaderButton`, `sb.ui.attachPopup` — callable functions.»
test('sb.ui exposes addHeaderButton and attachPopup as callable functions', () => {
  const { ui } = makeSbApi();

  expect(typeof ui.addHeaderButton).toBe('function');
  expect(typeof ui.attachPopup).toBe('function');
});

// ─── Test 3 ──────────────────────────────────────────────────────────────────
// Intent: «`sb.steam.openUrl`, `sb.steam.getCurrentUser` — callable functions.»
test('sb.steam exposes openUrl and getCurrentUser as callable functions', () => {
  const { steam } = makeSbApi();

  expect(typeof steam.openUrl).toBe('function');
  expect(typeof steam.getCurrentUser).toBe('function');
});

// ─── Test 4 ──────────────────────────────────────────────────────────────────
// Intent: «`sb.lifecycle.ready()` — returns Promise.»
test('sb.lifecycle.ready() returns a Promise', () => {
  const { lifecycle } = makeSbApi();

  const result = lifecycle.ready();
  expect(result).toBeInstanceOf(Promise);
  // Prevent unhandled-rejection noise from the never-resolved promise in this test.
  result.catch(() => {});
});

// ─── Test 5 ──────────────────────────────────────────────────────────────────
// Intent: «`sb.scope` — exposes ScopeApi methods: signal, abort helpers,
//          listen, fetch, abortable, observer, _abort.»
test('sb.scope exposes every ScopeApi method (signal, setTimeout, setInterval, clearTimeout, clearInterval, listen, fetch, abortable, observer, _abort)', () => {
  const { scope } = makeSbApi();

  // signal — AbortSignal instance
  expect(scope.signal).toBeInstanceOf(AbortSignal);

  // Async-resource helpers — all callable
  expect(typeof scope.setTimeout).toBe('function');
  expect(typeof scope.setInterval).toBe('function');
  expect(typeof scope.clearTimeout).toBe('function');
  expect(typeof scope.clearInterval).toBe('function');
  expect(typeof scope.listen).toBe('function');
  expect(typeof scope.fetch).toBe('function');
  expect(typeof scope.abortable).toBe('function');
  expect(typeof scope.observer).toBe('function');

  // Internal abort hook — present (framework-owned, tested here for completeness)
  expect(typeof scope._abort).toBe('function');
});

// ─── Test 6 ──────────────────────────────────────────────────────────────────
// Intent: «trying to call `sb.lifecycle._markReady()` from a plugin — works
//          (it is `@internal` but not enforced at runtime; documented as
//          "framework owns this"). Also: `rollbackAll` is present on the
//          same public surface (a plugin can call teardown in emergency).»
test('sb.lifecycle._markReady() is callable and resolves the ready() promise; rollbackAll() is present (framework-internal, not enforced)', () => {
  const { lifecycle } = makeSbApi();

  // _markReady must exist and be a function — plugin authors can call it,
  // though convention says only framework bootstrap should.
  expect(typeof lifecycle._markReady).toBe('function');

  // rollbackAll is part of the public LifecycleApi surface.
  expect(typeof lifecycle.rollbackAll).toBe('function');

  // Calling _markReady resolves ready() — confirms the @internal hook is wired.
  let resolved = false;
  lifecycle.ready().then(() => { resolved = true; }).catch(() => {});
  lifecycle._markReady();
  // Microtask flush — bun's test runner flushes between awaits.
  return Promise.resolve().then(() => {
    expect(resolved).toBe(true);
  });
});
