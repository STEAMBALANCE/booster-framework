import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import { Window } from 'happy-dom';
import { RELAY_CHANNEL, POPUP_ID_RE, POPUP_HTML_MAX_BYTES } from '../src/relay/protocol';
import { createScope } from '../src/api/scope';

let win: Window;
let stopRelay: (() => void) | null = null;

// 30ms is enough to flush BroadcastChannel dispatch (cross-listener within
// a single Bun process) plus any inline microtask. Centralising the magic
// number so future changes to BC dispatch latency only need one tweak.
const flushBC = () => new Promise((r) => setTimeout(r, 30));

// Mock the chromeless contextmenu template Steam exposes via
// g_PopupManager.m_mapPopups.get('contextmenu_1_uid0'). Real-Steam values for
// flags/target_browser/window_opener_id were captured by probe-steam-internal.
// Capture object for inspecting mock interactions. The `events` array tracks
// the *order* of calls — count assertions can flake when a refactor moves
// calls around (regression: "we changed the implementation, the count moved
// by 1 because of an unrelated path, and the assertion stayed green by
// coincidence"). Order assertions catch that.
interface MockCapture {
  constructor: { calls: Array<{ name: string; params: Record<string, unknown> }> };
  showCalls: { count: number };
  hideCalls: { count: number };
  setHideOnCloseCalls: { count: number };
  setKeyFocusCalls: Array<boolean>;
  moveToCalls: Array<[number, number, number]>;  // includes scale arg
  resizeToCalls: Array<[number, number, number]>;
  showWindowCalls: { count: number };
  writtenHtml: { last: string };
  events: string[];
}

function newCapture(): MockCapture {
  return {
    constructor: { calls: [] },
    showCalls: { count: 0 },
    hideCalls: { count: 0 },
    setHideOnCloseCalls: { count: 0 },
    setKeyFocusCalls: [],
    moveToCalls: [],
    resizeToCalls: [],
    showWindowCalls: { count: 0 },
    writtenHtml: { last: '' },
    events: [],
  };
}

function installPopupManagerMock(opts: {
  capture?: MockCapture;
  popupCtor?: () => unknown;  // override to fail Show etc.
  // If true, the mock pool only has contextmenu_5_uid0 (not _1) — covers
  // the highest-numbered-pick path in getPopupTemplate.
  gappyPool?: boolean;
  // Simulates Steam's PopupClass behavior. When true (default), Show()
  // fires `m_callbacks.onCreate` if the relay set it — mirroring fresh
  // popup creation. When false, Show() skips the callback dispatch —
  // mirroring Steam's adoption path (where `replace_existing_popup:
  // true` reuses an orphan CEF window WITHOUT re-firing OnCreate).
  // The relay's contract (post-Show rewriteContent) must hold under
  // both modes: see the "adoption case" regression test.
  fireOnCreateOnShow?: boolean;
} = {}) {
  const cap = opts.capture;
  const fireOnCreate = opts.fireOnCreateOnShow ?? true;
  const push = (e: string) => { if (cap) cap.events.push(e); };
  const fakeWindow = {
    closed: false,
    document: {
      open: () => {},
      write: (html: string) => { if (cap) cap.writtenHtml.last = html; push('write'); },
      close: () => {},
      hasFocus: () => true,
    },
    SteamClient: {
      Window: {
        SetHideOnClose: (_on: boolean) => { if (cap) cap.setHideOnCloseCalls.count++; push('SetHideOnClose'); },
        HideWindow: () => { if (cap) cap.hideCalls.count++; push('HideWindow'); },
        ShowWindow: () => { if (cap) cap.showWindowCalls.count++; push('ShowWindow'); },
        MoveTo: (x: number, y: number, s = 1) => { if (cap) cap.moveToCalls.push([x, y, s]); push('MoveTo'); },
        ResizeTo: (w: number, h: number, s = 1) => { if (cap) cap.resizeToCalls.push([w, h, s]); push('ResizeTo'); },
        SetKeyFocus: (on: boolean) => { if (cap) cap.setKeyFocusCalls.push(on); push('SetKeyFocus'); },
        BringToFront: () => { push('BringToFront'); },
        Close: () => { push('Close'); },
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
  };

  // m_callbacks is preserved on FakePopup as a test seam: production
  // code today does NOT set m_callbacks (Bug 2 fix removed that path
  // in favor of explicit post-Show rewriteContent), but a regression
  // that re-introduces the m_callbacks pattern would be caught by
  // the adoption-case test (fireOnCreateOnShow: false → mock skips
  // dispatch → if production were depending on onCreate again,
  // rewriteContent wouldn't fire and the assertion would go red).
  class FakePopup {
    m_strName: string;
    m_rgParams: Record<string, unknown>;
    m_popup: typeof fakeWindow | undefined = undefined;
    m_callbacks?: { onCreate?: (w: typeof fakeWindow) => void };
    constructor(name: string, params: Record<string, unknown>) {
      if (cap) cap.constructor.calls.push({ name, params });
      this.m_strName = name;
      this.m_rgParams = params;
    }
    Show(): void {
      if (cap) cap.showCalls.count++;
      push('Popup.Show');
      this.m_popup = fakeWindow;
      if (fireOnCreate) this.m_callbacks?.onCreate?.(fakeWindow);
    }
    Close(): void { fakeWindow.closed = true; }
    BIsClosed(): boolean { return fakeWindow.closed; }
    BIsVisible(): boolean { return false; }
  }

  const baseParams = {
    html_class: '_14wqdluDeDnnEcg3OSLEmd client_chat_frame',
    body_class: 'ContextMenuPopupBody DesktopUI',
    popup_class: 'PopupTarget',
    replace_existing_popup: false,
    target_browser: { m_unPID: 0, m_nBrowserID: -1, m_unAppID: 0, m_eUIMode: 7 },
    window_opener_id: 3,
    bHideOnClose: true,
    eCreationFlags: 5529866,
    dimensions: { left: 100000, top: 100000, width: 2, height: 1 },
  };

  const cmEntry = {
    m_strName: 'contextmenu_template',
    m_rgParams: baseParams,
    constructor: opts.popupCtor ?? (FakePopup as unknown as () => unknown),
  };

  const map = opts.gappyPool
    ? new Map([['contextmenu_5_uid0', cmEntry]])
    : new Map([['contextmenu_1_uid0', cmEntry]]);
  const pm = { m_mapPopups: map };
  // @ts-expect-error - mock g_PopupManager
  globalThis.g_PopupManager = pm;
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = pm;
  return { fakeWindow };
}

beforeEach(() => {
  win = new Window();
  // happy-dom 20 doesn't populate window.SyntaxError; safe to patch in tests.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // Bun provides a global BroadcastChannel that works cross-listener within
  // a single process — we use that. happy-dom 20 doesn't ship its own BC.
  // @ts-expect-error - happy-dom Window type assigned to globalThis.window
  globalThis.window = win;
  // @ts-expect-error - mock SteamClient (only fields relay touches)
  globalThis.SteamClient = {};
  // @ts-expect-error - mock MainWindowBrowserManager
  globalThis.MainWindowBrowserManager = {
    LoadURL: (_url: string) => {},
  };
  // mirror the SteamClient/MWBM onto win so window.* accesses resolve too
  (win as unknown as { SteamClient: unknown }).SteamClient = (globalThis as unknown as { SteamClient: unknown }).SteamClient;
  (win as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager =
    (globalThis as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager;
});

afterEach(() => {
  if (stopRelay) {
    stopRelay();
    stopRelay = null;
  }
});

test('relay handles navigate request → MWBM.LoadURL + navigate-done reply', async () => {
  let loadedUrl = '';
  const mwbm = { LoadURL: (u: string) => { loadedUrl = u; } };
  // @ts-expect-error
  globalThis.MainWindowBrowserManager = mwbm;
  (win as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager = mwbm;

  // Re-import fresh: the relay module has a module-level guard via window.__sb_relay_started.
  // Each Window in happy-dom is a fresh instance so the guard remains false.
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  sender.postMessage({ kind: 'navigate', requestId: 7, url: 'https://steambalance.cc/pay/abc' });
  await flushBC();

  expect(loadedUrl).toBe('https://steambalance.cc/pay/abc');
  expect(
    replies.find((r) => r.kind === 'navigate-done' && r.requestId === 7),
  ).toBeTruthy();
  sender.close();
});

test('relay rejects unsafe navigate urls before LoadURL', async () => {
  let loadedUrl = '';
  const mwbm = { LoadURL: (u: string) => { loadedUrl = u; } };
  // @ts-expect-error
  globalThis.MainWindowBrowserManager = mwbm;
  (win as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager = mwbm;

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  for (const [i, url] of [
    'javascript:alert(1)',
    'http://steambalance.cc/x',
    'https://user:pass@steambalance.cc/x',
    'https://steambalance.cc:8443/x',
  ].entries()) {
    sender.postMessage({ kind: 'navigate', requestId: 70 + i, url });
    await flushBC();
  }

  expect(loadedUrl).toBe('');
  expect(replies.filter((r) => r.kind === 'navigate-error').length).toBe(4);
  sender.close();
});

test('relay handles attach-popup → constructs Popup with chromeless flags + writes html + reply', async () => {
  const cap = newCapture();
  installPopupManagerMock({ capture: cap });

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  sender.postMessage({
    kind: 'attach-popup',
    requestId: 11,
    popupId: 'pid-x',
    width: 320,
    height: 240,
    html: '<p>x</p>',
    hideOnBlur: true,
  });
  await flushBC();

  // Constructor invoked exactly once with chromeless flags borrowed from
  // contextmenu_N's m_rgParams. body_class is OUR sb_topup_body, not
  // Steam's ContextMenuPopupBody — protects against Steam stylesheet
  // leaks into the plugin's HTML.
  expect(cap.constructor.calls.length).toBe(1);
  // After length-1 assertion above, calls[0] is non-undefined; tsc with
  // noUncheckedIndexedAccess can't see through the assertion, so we
  // extract to a local once with a non-null assertion.
  const firstCall = cap.constructor.calls[0]!;
  expect(firstCall.name).toBe('pid-x');
  const params = firstCall.params;
  // Default eCreationFlags pin: STEAM_DROPDOWN_FLAGS = 4538634, the same
  // bitset Steam's own Notifications/Account/Supernavs use. The bits that
  // matter: NATIVE_BORDER on, ALWAYS_ON_TOP off, OVERRIDE_REDIRECT off.
  // Plugins can re-enable overrides via attachPopup({ alwaysOnTop: true, ... }).
  expect(params.eCreationFlags).toBe(4538634);
  expect(params.bHideOnClose).toBe(true);
  expect(params.body_class).toBe('sb_topup_body');
  expect((params.dimensions as { width: number }).width).toBe(320);
  expect((params.dimensions as { height: number }).height).toBe(240);

  // Order-sensitive contract: Show() first, then SetHideOnClose, then the
  // CEF realize warmup (ShowWindow + HideWindow paired), then explicit
  // rewriteContent. The write happens AFTER warmup (not from inside
  // Show via m_callbacks.onCreate) so that the adoption case — where
  // Steam reuses an orphan CEF window without firing OnCreate — also
  // gets its content rewritten. Direct count + order checks — not just
  // "showWindowCalls===2" which would silently pass if the warmup
  // HideWindow regressed.
  expect(cap.events).toEqual([
    'Popup.Show',
    'SetHideOnClose',
    'ShowWindow',  // warmup
    'HideWindow',  // warmup-pair: guards against the visible-flicker regression
    'write',       // post-Show rewriteContent — covers both fresh + adopted popups
  ]);
  expect(cap.writtenHtml.last).toBe('<p>x</p>');

  // Reply
  expect(
    replies.find((r) => r.kind === 'popup-attached' && r.requestId === 11 && r.popupId === 'pid-x'),
  ).toBeTruthy();
  sender.close();
});

test('relay attach-popup writes html via post-Show rewrite even when onCreate never fires (adoption case)', async () => {
  // Steam's PopupClass with `replace_existing_popup: true` can ADOPT an
  // orphan CEF window left behind by a prior session whose teardown
  // didn't fully destroy the native window (close-becomes-hide cascade
  // short-circuits despite SetHideOnClose(false) — see teardown's
  // load-bearing-order comment in shared-context.ts). On adoption,
  // m_callbacks.onCreate is NOT invoked because Steam considers the
  // popup "already created". If the relay relies solely on
  // m_callbacks.onCreate to write our HTML, the adopted popup keeps
  // its stale/template content and the user sees a black popup
  // (Bug 2, ~1/10 hot-reloads). Contract tested here: rewriteContent
  // must run even when Show() does NOT trigger m_callbacks.onCreate.
  const cap = newCapture();
  installPopupManagerMock({ capture: cap, fireOnCreateOnShow: false });

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  sender.postMessage({
    kind: 'attach-popup',
    requestId: 12,
    popupId: 'adopted',
    width: 320,
    height: 240,
    html: '<p>survives-adoption</p>',
    hideOnBlur: false,
  });
  await flushBC();

  // Critical assertion: html WAS written to the popup window even
  // though Show() never fired onCreate. This is the contract that
  // protects users from a black popup post-hot-reload.
  expect(cap.writtenHtml.last).toBe('<p>survives-adoption</p>');

  // Reply: popup-attached must still be sent so the caller's await
  // attachPopup resolves successfully (adoption is a successful
  // attach, not an error).
  expect(
    replies.find((r) => r.kind === 'popup-attached' && r.requestId === 12 && r.popupId === 'adopted'),
  ).toBeTruthy();
  sender.close();
});

test('relay attach-popup is idempotent — second attach with same id reuses window', async () => {
  const cap = newCapture();
  installPopupManagerMock({ capture: cap });

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  sender.postMessage({ kind: 'attach-popup', requestId: 1, popupId: 'p', width: 100, height: 100, html: '<p>1</p>', hideOnBlur: true });
  await flushBC();
  sender.postMessage({ kind: 'attach-popup', requestId: 2, popupId: 'p', width: 100, height: 100, html: '<p>2</p>', hideOnBlur: true });
  await flushBC();

  // Same popupId twice: only ONE construction. Second attach reused.
  expect(cap.constructor.calls.length).toBe(1);
  expect(cap.showCalls.count).toBe(1);
  // Second attach overwrote html via rewriteContent
  expect(cap.writtenHtml.last).toBe('<p>2</p>');
  sender.close();
});

test('relay popup-show calls MoveTo + ResizeTo + ShowWindow + SetKeyFocus in order', async () => {
  const cap = newCapture();
  installPopupManagerMock({ capture: cap });

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  sender.postMessage({ kind: 'attach-popup', requestId: 1, popupId: 'p2', width: 320, height: 240, html: '<p/>', hideOnBlur: false });
  await flushBC();
  // Snapshot events at end of attach so we can compare just the show
  // sequence below.
  const eventsAfterAttach = cap.events.length;
  sender.postMessage({ kind: 'popup-show', popupId: 'p2', x: 1700, y: 70 });
  await flushBC();

  // happy-dom's window.devicePixelRatio defaults to 1, so the scale arg
  // passed through is 1 in this environment. The contract under test is
  // that the scale arg is forwarded — production passes window.dpr=1.25
  // on a 125% display, which produces the correct on-screen sizing
  // (verified empirically via probe-scale-test).
  expect(cap.moveToCalls).toContainEqual([1700, 70, 1]);
  expect(cap.resizeToCalls).toContainEqual([320, 240, 1]);

  // Order-sensitive: show ordering matters because if SetKeyFocus fires
  // BEFORE ShowWindow on a hidden window, the focus call no-ops (no
  // window to focus) and the blur-poll immediately hides the popup on
  // the next tick.
  const showSeq = cap.events.slice(eventsAfterAttach);
  expect(showSeq).toEqual([
    'MoveTo',
    'ResizeTo',
    'ShowWindow',
    'BringToFront',
    'SetKeyFocus',
  ]);
  // SetKeyFocus(true) — exactly the value we pass to claim focus.
  expect(cap.setKeyFocusCalls).toEqual([true]);
  sender.close();
});

test('relay popup-show falls through if popup never attached (silent no-op)', async () => {
  const cap = newCapture();
  installPopupManagerMock({ capture: cap });
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  sender.postMessage({ kind: 'popup-show', popupId: 'never-attached', x: 0, y: 0 });
  await flushBC();

  // No interactions on the mock window at all — the relay didn't reach
  // showPopupNative because the popups map didn't have an entry.
  expect(cap.events).toEqual([]);
  sender.close();
});

test('relay walks contextmenu pool when _1 is absent', async () => {
  const cap = newCapture();
  installPopupManagerMock({ capture: cap, gappyPool: true });
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());
  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });
  sender.postMessage({ kind: 'attach-popup', requestId: 1, popupId: 'p3', width: 100, height: 100, html: '<p/>', hideOnBlur: false });
  await flushBC();
  // mock has only contextmenu_5_uid0 (no _1) — getPopupTemplate must
  // walk the pool, not hardcode _1.
  expect(replies.find((r) => r.kind === 'popup-attached' && r.requestId === 1)).toBeTruthy();
  sender.close();
});

test('relay returns popup-attach-error when g_PopupManager unavailable', async () => {
  // Don't install the mock — leave g_PopupManager undefined. Relay must reply
  // popup-attach-error so the caller's `await attachPopup` rejects rather
  // than hanging to the 5s timeout.
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  sender.postMessage({
    kind: 'attach-popup',
    requestId: 22,
    popupId: 'no-pm',
    width: 100, height: 100, html: '<p/>', hideOnBlur: false,
  });
  await flushBC();

  const err = replies.find((r) => r.kind === 'popup-attach-error' && r.requestId === 22);
  expect(err).toBeTruthy();
  expect((err as { error: string }).error).toContain('g_PopupManager template unavailable');
  sender.close();
});

// ---------------------------------------------------------------------------
// installUserChangeListener tests (push-based listener from ./user-data)
// ---------------------------------------------------------------------------

interface UserChangeMock {
  registeredCb: { value: ((info: unknown) => void) | null };
  unregisterCalls: { count: number };
}

// Shared setup helper for installUserChangeListener tests. Returns
// { registeredCb, unregisterCalls } so each test can drive callback firing
// manually via `registeredCb.value!(info)`. Sets `win.SteamClient` to a
// minimal-but-valid shape covering all SteamClient methods the relay reaches.
function setupUserChangeMock(): UserChangeMock {
  const cb = { value: null as ((info: unknown) => void) | null };
  const unreg = { count: 0 };
  (win as unknown as { SteamClient: unknown }).SteamClient = {
    User: {
      GetLoginUsers: async () => [{ accountName: 'matrix' }],
      GetIPCountry: async () => 'RU',
      RegisterForCurrentUserChanges: (fn: (info: unknown) => void) => {
        cb.value = fn;
        return { unregister: () => { unreg.count++; } };
      },
    },
    Settings: { GetAccountSettings: async () => ({}), GetCurrentLanguage: async () => 'english' },
  };
  installPopupManagerMock({ capture: newCapture() });
  return { registeredCb: cb, unregisterCalls: unreg };
}

async function startRelayHelper(): Promise<{ scope: ReturnType<typeof createScope> }> {
  const scope = createScope();
  stopRelay = (await import('../src/relay/shared-context')).startRelay(scope);
  await flushBC();
  return { scope };
}

test('installUserChangeListener: scope.abort unregisters', async () => {
  // Push-based listener (from ./user-data) registers once via startRelay.
  // On abort, unregister must be called exactly once.
  const m = setupUserChangeMock();
  const { scope } = await startRelayHelper();
  scope._abort();
  expect(m.unregisterCalls.count).toBe(1);
});

test('installUserChangeListener: SteamClient.User absent — graceful no-op', async () => {
  (win as unknown as { SteamClient: unknown }).SteamClient = {};
  installPopupManagerMock({ capture: newCapture() });
  const scope = createScope();
  // Must not throw even though RegisterForCurrentUserChanges is absent.
  const { startRelay } = await import('../src/relay/shared-context');
  expect(() => {
    stopRelay = startRelay(scope);
  }).not.toThrow();
});

test('installUserChangeListener: idempotent — second startRelay does not double-register', async () => {
  let registerCalls = 0;
  (win as unknown as { SteamClient: unknown }).SteamClient = {
    User: {
      GetLoginUsers: async () => [{ accountName: 'matrix' }],
      GetIPCountry: async () => 'RU',
      RegisterForCurrentUserChanges: () => {
        registerCalls++;
        return { unregister: () => {} };
      },
    },
    Settings: { GetAccountSettings: async () => ({}), GetCurrentLanguage: async () => 'en' },
  };
  installPopupManagerMock({ capture: newCapture() });
  const scope = createScope();
  // Push-based listener registers once on the first startRelay call.
  // The relay's `__sb_relay_started` guard prevents the SECOND startRelay
  // call from registering at all (count stays at 1, not 2).
  stopRelay = (await import('../src/relay/shared-context')).startRelay(scope);
  await flushBC();
  (await import('../src/relay/shared-context')).startRelay(scope);
  await flushBC();
  expect(registerCalls).toBe(1);
});

test('relay rejects attach-popup with invalid popupId regex', async () => {
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  sender.postMessage({
    kind: 'attach-popup',
    requestId: 50,
    popupId: 'has spaces!',
    width: 100, height: 100, html: '<p/>', hideOnBlur: false,
  });
  await flushBC();

  const err = replies.find((r) => r.kind === 'popup-attach-error' && r.requestId === 50);
  expect(err).toBeTruthy();
  expect((err as { error: string }).error).toContain('invalid popupId');
  sender.close();
});

// POPUP_ID_RE boundary tests — pure unit tests on the exported regex,
// no BroadcastChannel/relay needed. These pin the exact regex contract
// (/^[a-zA-Z0-9_-]{1,64}$/) so a length or charset change is caught
// immediately without tracing a relay round-trip.
describe('POPUP_ID_RE boundary', () => {
  test('1-character popup id accepted (boundary: min length)', () => {
    expect(POPUP_ID_RE.test('a')).toBe(true);
  });

  test('64-character popup id accepted (boundary: max length)', () => {
    expect(POPUP_ID_RE.test('a'.repeat(64))).toBe(true);
  });

  test('65-character popup id rejected (boundary: one over max)', () => {
    expect(POPUP_ID_RE.test('a'.repeat(65))).toBe(false);
  });

  test('empty string popup id rejected (boundary: under min)', () => {
    expect(POPUP_ID_RE.test('')).toBe(false);
  });

  test('non-ASCII Cyrillic popup id rejected', () => {
    expect(POPUP_ID_RE.test('абв')).toBe(false);
  });

  test('popup id with emoji rejected (non-ASCII)', () => {
    expect(POPUP_ID_RE.test('a😀b')).toBe(false);
  });

  test('popup id with dot rejected (special character outside charset)', () => {
    expect(POPUP_ID_RE.test('foo.bar')).toBe(false);
  });

  test('popup id with space rejected (special character outside charset)', () => {
    expect(POPUP_ID_RE.test('foo bar')).toBe(false);
  });

  test('valid popup id with hyphens and underscores accepted', () => {
    // Both - and _ are explicitly in the charset; verify they are not
    // accidentally dropped by a regex edit.
    expect(POPUP_ID_RE.test('booster-topup_popup')).toBe(true);
  });
});

test('relay rejects attach-popup with html too large', async () => {
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  // One byte over POPUP_HTML_MAX_BYTES → rejected (robust to the limit value).
  const huge = 'x'.repeat(POPUP_HTML_MAX_BYTES + 1);
  sender.postMessage({
    kind: 'attach-popup',
    requestId: 51,
    popupId: 'big',
    width: 100, height: 100, html: huge, hideOnBlur: false,
  });
  await flushBC();

  const err = replies.find((r) => r.kind === 'popup-attach-error' && r.requestId === 51);
  expect(err).toBeTruthy();
  expect((err as { error: string }).error).toContain('html too large');
  sender.close();
});

describe('POPUP_HTML_MAX_BYTES boundary', () => {
  // The production guard is: msg.html.length > POPUP_HTML_MAX_BYTES
  // which means exactly-at-cap is accepted; one byte over is rejected.

  test('html exactly at POPUP_HTML_MAX_BYTES is accepted', async () => {
    // Install popup manager mock so construction can proceed past the size gate.
    // Without it, the relay would emit popup-attach-error("g_PopupManager template
    // unavailable") which would obscure whether the size check fired or not.
    installPopupManagerMock();
    const { startRelay } = await import('../src/relay/shared-context');
    stopRelay = startRelay(createScope());

    const sender = new BroadcastChannel(RELAY_CHANNEL);
    const replies: Array<Record<string, unknown>> = [];
    sender.addEventListener('message', (e: MessageEvent) => {
      replies.push(e.data as Record<string, unknown>);
    });

    // Construct html whose .length === 256 * 1024 exactly.
    const exactHtml = 'x'.repeat(POPUP_HTML_MAX_BYTES);
    sender.postMessage({
      kind: 'attach-popup',
      requestId: 61,
      popupId: 'exact-cap',
      width: 100, height: 100, html: exactHtml, hideOnBlur: false,
    });
    await flushBC();

    // Exactly at cap must not be rejected by the size guard.
    // The production check is strict >: html.length > POPUP_HTML_MAX_BYTES.
    // A popup-attach-error with "html too large" would mean the guard fired incorrectly.
    const sizeErr = replies.find(
      (r) => r.kind === 'popup-attach-error' && r.requestId === 61 &&
             typeof r.error === 'string' && (r.error as string).includes('html too large'),
    );
    expect(sizeErr).toBeUndefined();
    sender.close();
  });

  test('html one byte over POPUP_HTML_MAX_BYTES is rejected', async () => {
    const { startRelay } = await import('../src/relay/shared-context');
    stopRelay = startRelay(createScope());

    const sender = new BroadcastChannel(RELAY_CHANNEL);
    const replies: Array<Record<string, unknown>> = [];
    sender.addEventListener('message', (e: MessageEvent) => {
      replies.push(e.data as Record<string, unknown>);
    });

    // One byte past the cap — the strict > check must fire.
    const overHtml = 'x'.repeat(POPUP_HTML_MAX_BYTES + 1);
    sender.postMessage({
      kind: 'attach-popup',
      requestId: 62,
      popupId: 'one-over-cap',
      width: 100, height: 100, html: overHtml, hideOnBlur: false,
    });
    await flushBC();

    const err = replies.find((r) => r.kind === 'popup-attach-error' && r.requestId === 62);
    expect(err).toBeTruthy();
    expect((err as { error: string }).error).toContain('html too large');
    sender.close();
  });
});

test('relay popup-show for unknown popupId is silent no-op (no exception)', async () => {
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  // No reply expected — handler logs a warn via __sb_native (which is
  // undefined in tests so it silently no-ops) and returns. Asserting
  // nothing throws is the actual contract.
  sender.postMessage({ kind: 'popup-show', popupId: 'never-attached', x: 0, y: 0 });
  sender.postMessage({ kind: 'popup-toggle', popupId: 'never-attached', x: 0, y: 0 });
  sender.postMessage({ kind: 'popup-hide', popupId: 'never-attached' });
  sender.postMessage({ kind: 'popup-postMessage', popupId: 'never-attached', data: { kind: 'x' } });
  await flushBC();

  // If we got here without an unhandled rejection, the contract holds.
  expect(true).toBe(true);
  sender.close();
});

test('relay attach-popup defers Popup construction to a microtask (BC handler returns first)', async () => {
  const order: string[] = [];
  // We want to verify the construction happens AFTER the BC handler returns.
  // The clean signal: install the popup manager mock with a constructor
  // that pushes a sentinel; the sender pushes a sentinel BEFORE postMessage.
  installPopupManagerMock();
  // Wrap the constructor to capture call order.
  const realCtor = (
    (globalThis as unknown as { g_PopupManager: { m_mapPopups: Map<string, { constructor: unknown }> } })
      .g_PopupManager.m_mapPopups.get('contextmenu_1_uid0') as { constructor: unknown }
  ).constructor as new (...args: unknown[]) => unknown;
  (
    (globalThis as unknown as { g_PopupManager: { m_mapPopups: Map<string, { constructor: unknown }> } })
      .g_PopupManager.m_mapPopups.get('contextmenu_1_uid0') as { constructor: unknown }
  ).constructor = function (...args: unknown[]) {
    order.push('construct');
    return new realCtor(...args);
  };

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  order.push('postMessage-pre');
  sender.postMessage({
    kind: 'attach-popup',
    requestId: 99,
    popupId: 'order',
    width: 100, height: 100, html: '<p/>', hideOnBlur: false,
  });
  order.push('postMessage-post');
  await flushBC();

  // postMessage returns synchronously (BC handler is called async). The
  // construction is microtask-deferred so BC handler returns first. The
  // observable invariant: at minimum, construction is the LAST entry in
  // `order`, meaning it didn't beat the postMessage-post landmark.
  expect(order[order.length - 1]).toBe('construct');
  sender.close();
});

test('relay returns navigate-error when MWBM unavailable', async () => {
  // remove MWBM
  // @ts-expect-error
  delete globalThis.MainWindowBrowserManager;
  delete (win as unknown as { MainWindowBrowserManager?: unknown }).MainWindowBrowserManager;

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  sender.postMessage({ kind: 'navigate', requestId: 8, url: 'https://steambalance.cc/x' });
  await flushBC();

  expect(replies.find((r) => r.kind === 'navigate-error' && r.requestId === 8)).toBeTruthy();
  sender.close();
});

test('relay scope._abort detaches BC listener — no further messages handled', async () => {
  // Contract: rollbackAll's scope abort must remove the BC
  // listener through the native AbortSignal path. After _abort, navigate
  // requests stop being dispatched to MainWindowBrowserManager — proving
  // the listener is gone. This guards against a regression where the
  // listener stays attached to bc and accumulates across re-injections.
  let loadedUrl = '';
  const mwbm = { LoadURL: (u: string) => { loadedUrl = u; } };
  // @ts-expect-error
  globalThis.MainWindowBrowserManager = mwbm;
  (win as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager = mwbm;

  const scope = createScope();
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(scope);

  const sender = new BroadcastChannel(RELAY_CHANNEL);
  sender.postMessage({ kind: 'navigate', requestId: 60, url: 'https://x.test/before' });
  await flushBC();
  expect(loadedUrl).toBe('https://x.test/before');

  // Abort scope. listener detaches via signal.
  scope._abort();
  loadedUrl = '';

  sender.postMessage({ kind: 'navigate', requestId: 61, url: 'https://x.test/after' });
  await flushBC();
  expect(loadedUrl).toBe('');
  sender.close();
});

test('relay attach-popup posted after teardown does not spawn a popup (tornDown guard)', async () => {
  // Contract pinned by the comment block at the top of attachPopupMicrotask
  // in shared-context.ts: when the relay tears down between the BC handler
  // returning and the deferred microtask running, the microtask must early-
  // return without constructing a popup and without writing to its document.
  const cap = newCapture();
  installPopupManagerMock({ capture: cap });
  const { startRelay } = await import('../src/relay/shared-context');
  const stop = startRelay(createScope());
  const sender = new BroadcastChannel(RELAY_CHANNEL);

  // Post the attach-popup, then immediately stop the relay before the BC
  // dispatch + microtask cycle resolves. The signal-bound BC listener
  // detaches the moment scope._abort runs inside stop(); any in-flight
  // microtask sees tornDown=true and bails.
  sender.postMessage({
    kind: 'attach-popup',
    requestId: 99,
    popupId: 'race',
    width: 100,
    height: 100,
    html: '<p/>',
    hideOnBlur: false,
  });
  stop();
  stopRelay = null;
  await flushBC();

  expect(cap.constructor.calls.length).toBe(0);
  expect(cap.writtenHtml.last).toBe('');
  sender.close();
});

test('relay reuse fast-path returns popup-attach-error when document.write throws', async () => {
  // Idempotent reuse-path failure: when the existing popup window's
  // document.write throws (CEF window lost / GPU process crash mid-life),
  // shared-context.ts:322-336 must destroy + drop the entry AND post a
  // popup-attach-error reply so the caller's `await attachPopup` rejects
  // instead of resolving against a now-dead window.
  const cap = newCapture();
  const installed = installPopupManagerMock({ capture: cap });
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(createScope());
  const sender = new BroadcastChannel(RELAY_CHANNEL);
  const replies: Array<Record<string, unknown>> = [];
  sender.addEventListener('message', (e: MessageEvent) => {
    replies.push(e.data as Record<string, unknown>);
  });

  // First attach succeeds — establishes the entry that the reuse-path
  // fast-path will hit on the next attach with the same id.
  sender.postMessage({
    kind: 'attach-popup', requestId: 1, popupId: 'reuse',
    width: 100, height: 100, html: '<p>v1</p>', hideOnBlur: false,
  });
  await flushBC();
  expect(replies.find((r) => r.kind === 'popup-attached' && r.requestId === 1)).toBeTruthy();

  // Sabotage document.write so the reuse fast-path's rewrite attempt fails.
  installed.fakeWindow.document.write = () => { throw new Error('document detached'); };

  // Second attach with same popupId → relay hits the reuse fast-path,
  // calls document.write, catches the throw, destroys the entry, replies
  // popup-attach-error.
  sender.postMessage({
    kind: 'attach-popup', requestId: 2, popupId: 'reuse',
    width: 100, height: 100, html: '<p>v2</p>', hideOnBlur: false,
  });
  await flushBC();

  const errReply = replies.find((r) => r.kind === 'popup-attach-error' && r.requestId === 2);
  expect(errReply).toBeTruthy();
  expect(errReply!['error']).toMatch(/reused popup document\.write failed/);
  // Constructor should have been called exactly once (the first attach).
  // The reuse-path failure does NOT spawn a fresh popup — caller is
  // expected to retry, not silently get a new window.
  expect(cap.constructor.calls.length).toBe(1);
  sender.close();
});

