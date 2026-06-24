// framework/tests/popup-toggle-gate.test.ts
//
// Integration tests for the relay-side popup-toggle gate.
// Uses a deterministic performance.now mock — no wall-clock flake.
// Four cases: first toggle shows, fast second is blocked, slow second hides,
// SB_POPUP_GATE_MS=0 disables the gate entirely.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { RELAY_CHANNEL } from '../src/relay/protocol';
import { createScope } from '../src/api/scope';

// ---------------------------------------------------------------------------
// Deterministic time control
// ---------------------------------------------------------------------------

let nowMs = 1000;
const advanceTime = (ms: number) => { nowMs += ms; };

// ---------------------------------------------------------------------------
// Module-level relay state
// ---------------------------------------------------------------------------

let stopRelay: (() => void) | null = null;
let scopeRef: ReturnType<typeof createScope> | null = null;

// flushBC: enough to drain BroadcastChannel dispatch (same-process,
// cross-listener) plus the microtask defer inside handleAttachPopup.
const flushBC = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------
// Fake popup window — same shape as relay/shared-context.ts expects from
// popup.m_popup after Show(). Matches the fakeWindow in relay.test.ts.
// ---------------------------------------------------------------------------

function makeFakeWindow() {
  return {
    closed: false,
    document: {
      open: () => {},
      write: (_html: string) => {},
      close: () => {},
      hasFocus: () => true,
    },
    SteamClient: {
      Window: {
        SetHideOnClose: (_on: boolean) => {},
        HideWindow: () => {},
        ShowWindow: () => {},
        MoveTo: (_x: number, _y: number, _s?: number) => {},
        ResizeTo: (_w: number, _h: number, _s?: number) => {},
        SetKeyFocus: (_on: boolean) => {},
        BringToFront: () => {},
        Close: () => {},
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
  };
}

// ---------------------------------------------------------------------------
// Install g_PopupManager with a FakePopup that populates m_popup on Show().
// Mirrors installPopupManagerMock from relay.test.ts but kept self-contained.
// ---------------------------------------------------------------------------

function installPopupManagerMock(): void {
  const fakeWindow = makeFakeWindow();

  class FakePopup {
    m_strName: string;
    m_rgParams: Record<string, unknown>;
    m_popup: ReturnType<typeof makeFakeWindow> | undefined = undefined;
    constructor(name: string, params: Record<string, unknown>, _cb: unknown) {
      this.m_strName = name;
      this.m_rgParams = params;
    }
    Show(): void {
      this.m_popup = fakeWindow;
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

  const pm = {
    m_mapPopups: new Map([
      ['contextmenu_1_uid0', {
        m_strName: 'contextmenu_template',
        m_rgParams: baseParams,
        constructor: FakePopup as unknown as () => unknown,
      }],
    ]),
    RemoveTrackedPopup: () => {},
  };

  // @ts-expect-error - mock g_PopupManager on both globalThis and window
  globalThis.g_PopupManager = pm;
  (window as unknown as { g_PopupManager: unknown }).g_PopupManager = pm;
}

// ---------------------------------------------------------------------------
// Fake SteamClient that satisfies installUserChangeListener + user-data.ts.
// RegisterForCurrentUserChanges must be a function; the relay installs a
// persistent listener on it at startRelay time.
// ---------------------------------------------------------------------------

function installFakeSteamClient(): void {
  const fakeSC = {
    User: {
      RegisterForCurrentUserChanges: (_cb: unknown) => ({ unregister: () => {} }),
    },
    Settings: {},
  };
  // @ts-expect-error - mock SteamClient
  globalThis.SteamClient = fakeSC;
  (window as unknown as { SteamClient: unknown }).SteamClient = fakeSC;
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(async () => {
  nowMs = 1000;
  // Fresh window — clears __sb_relay_started so startRelay installs cleanly.
  const win = new Window();
  // happy-dom 20 doesn't populate SyntaxError; patch so relay json-parse paths work.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error - happy-dom Window assigned to globalThis.window
  globalThis.window = win;

  // Mock performance.now globally — relay reads `performance.now()` directly.
  // This must happen BEFORE startRelay so getGateMs-aware call sites see the mock.
  (globalThis as unknown as { performance: { now: () => number } }).performance = {
    now: () => nowMs,
  };

  // Default: gate enabled (250 ms). Per-test cases override before setup.
  delete process.env['SB_POPUP_GATE_MS'];

  // Reset user-data module-level state so installUserChangeListener
  // doesn't skip registration due to the cached listenerActive flag.
  try {
    const ud = await import('../src/relay/user-data');
    (ud as { __resetForTests?: () => void }).__resetForTests?.();
  } catch { /* module may not be cached yet */ }
});

afterEach(() => {
  try { stopRelay?.(); } catch {}
  try { scopeRef?._abort(); } catch {}
  stopRelay = null;
  scopeRef = null;
  // Belt-and-braces: wipe the relay-started flag so the next test's
  // startRelay call isn't a no-op even if teardown somehow skipped it.
  try {
    delete (globalThis.window as { __sb_relay_started?: boolean }).__sb_relay_started;
  } catch {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupRelayWithFakePopup(): Promise<{ bc: BroadcastChannel }> {
  installPopupManagerMock();
  installFakeSteamClient();
  scopeRef = createScope();
  // Dynamic import so each test gets the module after globalThis.window is set.
  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(scopeRef);
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  return { bc };
}

async function attachAndWait(bc: BroadcastChannel, popupId: string): Promise<void> {
  bc.postMessage({
    kind: 'attach-popup',
    requestId: 1,
    popupId,
    html: '<x>',
    width: 320,
    height: 142,
    hideOnBlur: false,
  });
  await flushBC();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('first popup-toggle on attached popup — shows popup (popup-show-event)', async () => {
  const { bc } = await setupRelayWithFakePopup();
  const events: Array<{ kind?: string; popupId?: string }> = [];
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  receiver.addEventListener('message', (ev) => {
    events.push(ev.data as { kind?: string; popupId?: string });
  });

  await attachAndWait(bc, 'p1');
  events.length = 0;  // discard popup-attached event

  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();

  expect(
    events.find((m) => m.kind === 'popup-show-event' && m.popupId === 'p1'),
  ).toBeDefined();

  receiver.close();
  bc.close();
});

test('second popup-toggle within 250ms — gate hit, no popup-hide-event', async () => {
  const { bc } = await setupRelayWithFakePopup();
  const events: Array<{ kind?: string; popupId?: string }> = [];
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  receiver.addEventListener('message', (ev) => {
    events.push(ev.data as { kind?: string; popupId?: string });
  });

  await attachAndWait(bc, 'p1');

  // First toggle: showPopupNative → stamps lastStateChangeAt = nowMs (1000).
  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();

  // Advance only 100ms — still inside the 250ms gate window.
  advanceTime(100);
  events.length = 0;

  // Second toggle: (now=1100) - (lastStateChangeAt=1000) = 100 < 250 → gate fires.
  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();

  // Gate consumed the call — popup must NOT have been hidden.
  expect(events.find((m) => m.kind === 'popup-hide-event')).toBeUndefined();

  receiver.close();
  bc.close();
});

test('second popup-toggle past 250ms — gate passes, popup-hide-event emitted', async () => {
  const { bc } = await setupRelayWithFakePopup();
  const events: Array<{ kind?: string; popupId?: string }> = [];
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  receiver.addEventListener('message', (ev) => {
    events.push(ev.data as { kind?: string; popupId?: string });
  });

  await attachAndWait(bc, 'p1');

  // First toggle: shows popup, stamps lastStateChangeAt = 1000.
  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();

  // Advance 300ms — past the 250ms gate.
  advanceTime(300);
  events.length = 0;

  // Second toggle: (now=1300) - (lastStateChangeAt=1000) = 300 >= 250 → gate passes.
  // Popup is visible, so hidePopupNative fires.
  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();

  expect(
    events.find((m) => m.kind === 'popup-hide-event' && m.popupId === 'p1'),
  ).toBeDefined();

  receiver.close();
  bc.close();
});

test('direct popup-show msg emits popup-show-event broadcast', async () => {
  const { bc } = await setupRelayWithFakePopup();
  const events: Array<{ kind?: string; popupId?: string }> = [];
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  receiver.addEventListener('message', (ev) => events.push(ev.data as { kind?: string; popupId?: string }));

  await attachAndWait(bc, 'p2');
  events.length = 0;

  bc.postMessage({ kind: 'popup-show', popupId: 'p2', x: 10, y: 20 });
  await new Promise((r) => setTimeout(r, 5));

  expect(events.find((m) => m.kind === 'popup-show-event' && m.popupId === 'p2')).toBeDefined();
  receiver.close();
  bc.close();
});

test('SB_POPUP_GATE_MS=0 — gate disabled, consecutive toggles both act', async () => {
  // Must set env var BEFORE setupRelayWithFakePopup so getGateMs() reads it.
  process.env['SB_POPUP_GATE_MS'] = '0';

  const { bc } = await setupRelayWithFakePopup();
  const events: Array<{ kind?: string; popupId?: string }> = [];
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  receiver.addEventListener('message', (ev) => {
    events.push(ev.data as { kind?: string; popupId?: string });
  });

  await attachAndWait(bc, 'p1');

  // First toggle: shows popup (no time has passed — but gate=0 so always acts).
  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();
  events.length = 0;

  // Second toggle immediately (nowMs unchanged) — with gate=0 it must act.
  bc.postMessage({ kind: 'popup-toggle', popupId: 'p1', x: 100, y: 100 });
  await flushBC();

  // Popup was visible, second toggle hid it.
  expect(events.find((m) => m.kind === 'popup-hide-event')).toBeDefined();

  receiver.close();
  bc.close();
  delete process.env['SB_POPUP_GATE_MS'];
});
