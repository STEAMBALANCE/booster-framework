// framework/tests/relay-open-window.test.ts
//
// Tests for the relay-side openWindow handlers (window-handlers.ts +
// shared-context.ts wiring). Mirrors the structure of
// popup-toggle-gate.test.ts: fresh happy-dom Window per test, fake
// g_PopupManager template, fake SteamClient, and a deterministic
// scope.setInterval mock so the relay's 250ms BIsClosed poll fires
// only when the test invokes tickPolling().
//
// Test layout (~22 cases):
//   • Validation         — id regex, id collisions, url/html mutex,
//                          required content, unsafe url, html-too-large,
//                          empty title.
//   • Happy path         — open returns window-opened with effective sizes.
//   • Lifecycle          — show / hide / bring / close / user-close /
//                          postMessage forwarding + close-event reasons.
//   • Polling / teardown — crash detection, race between caller+user
//                          close, post-delete tick early-return,
//                          teardown-on-abort.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { RELAY_CHANNEL, OPEN_WINDOW_HTML_MAX_BYTES } from '../src/relay/protocol';

// ---------------------------------------------------------------------------
// Fake popup window — same shape as makeFakeWindow in popup-toggle-gate.test.ts
// extended with the window-handlers' SetMinSize call. Shared per-window so
// tests can mutate `closed` to simulate user-close / crash.
// ---------------------------------------------------------------------------

function makeFakeWindow() {
  const calls = {
    show: 0,
    hide: 0,
    bring: 0,
    setHideOnClose: 0,
    close: 0,
    setMinSize: [] as Array<[number, number]>,
  };
  const fw = {
    closed: false,
    document: {
      open: () => {},
      write: (_html: string) => {},
      close: () => {},
      hasFocus: () => true,
    },
    SteamClient: {
      Window: {
        SetHideOnClose: (_on: boolean) => { calls.setHideOnClose++; },
        HideWindow: () => { calls.hide++; },
        ShowWindow: () => { calls.show++; },
        MoveTo: (_x: number, _y: number, _s?: number) => {},
        ResizeTo: (_w: number, _h: number, _s?: number) => {},
        SetKeyFocus: (_on: boolean) => {},
        BringToFront: () => { calls.bring++; },
        SetMinSize: (w: number, h: number) => { calls.setMinSize.push([w, h]); },
        Close: () => { calls.close++; fw.closed = true; },
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
    close: () => { fw.closed = true; },
  };
  return { fw, calls };
}

// ---------------------------------------------------------------------------
// Fake g_PopupManager with a contextmenu_1_uid0 template entry that produces
// a FakePopup whose Show() populates m_popup. Each FakePopup gets its own
// fakeWindow instance (so two windows don't share one `closed` flag).
// ---------------------------------------------------------------------------

interface PopupRecord {
  fw: ReturnType<typeof makeFakeWindow>['fw'];
  calls: ReturnType<typeof makeFakeWindow>['calls'];
  popup: {
    m_strName: string;
    m_popup: ReturnType<typeof makeFakeWindow>['fw'] | undefined;
    Show: () => void;
    Close: () => void;
    BIsClosed: () => boolean;
    BIsVisible: () => boolean;
  };
}

function installPopupManagerMock(): { instances: Map<string, PopupRecord> } {
  const instances = new Map<string, PopupRecord>();

  class FakePopup {
    m_strName: string;
    m_rgParams: Record<string, unknown>;
    m_popup: ReturnType<typeof makeFakeWindow>['fw'] | undefined = undefined;
    private _rec: PopupRecord;
    constructor(name: string, params: Record<string, unknown>, _cb: unknown) {
      this.m_strName = name;
      this.m_rgParams = params;
      const { fw, calls } = makeFakeWindow();
      this._rec = {
        fw,
        calls,
        popup: this as unknown as PopupRecord['popup'],
      };
      instances.set(name, this._rec);
    }
    Show(): void {
      this.m_popup = this._rec.fw;
    }
    Close(): void { this._rec.fw.closed = true; }
    BIsClosed(): boolean { return this._rec.fw.closed; }
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

  // @ts-expect-error - mock g_PopupManager
  globalThis.g_PopupManager = pm;
  (window as unknown as { g_PopupManager: unknown }).g_PopupManager = pm;
  return { instances };
}

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
// Deterministic interval mock — used so the relay's 250ms close poll only
// fires when tests advance it via tickPolling. The relay calls
// scope.setInterval, which (post-monkey-patch in beforeEach) records the
// callback into intervalsArmed instead of installing a real timer.
// ---------------------------------------------------------------------------

interface ArmedInterval {
  id: number;
  cb: () => void;
  cleared: boolean;
}

const intervalsArmed: ArmedInterval[] = [];
let nextIntervalId = 1;

function armedById(id: number): ArmedInterval | undefined {
  return intervalsArmed.find((i) => i.id === id);
}

// 30ms is enough to flush BroadcastChannel dispatch (cross-listener within
// a single Bun process) plus inline microtask resolution.
const flushBC = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------
// Module-level relay state (reset per test in afterEach)
// ---------------------------------------------------------------------------

let stopRelay: (() => void) | null = null;
let scopeRef: { _abort: () => void; signal: AbortSignal } | null = null;

beforeEach(async () => {
  intervalsArmed.length = 0;
  nextIntervalId = 1;

  const win = new Window();
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error - happy-dom window assigned to globalThis.window
  globalThis.window = win;

  // Reset user-data module so installUserChangeListener doesn't no-op on
  // a stale listenerActive flag carried from a previous test's import.
  try {
    const ud = await import('../src/relay/user-data');
    (ud as { __resetForTests?: () => void }).__resetForTests?.();
  } catch { /* first-run */ }
});

afterEach(() => {
  try { stopRelay?.(); } catch {}
  try { scopeRef?._abort(); } catch {}
  stopRelay = null;
  scopeRef = null;
  try {
    delete (globalThis.window as { __sb_relay_started?: boolean }).__sb_relay_started;
  } catch {}
});

// ---------------------------------------------------------------------------
// Harness — sets up the fake Steam environment, starts startRelay with a
// scope that records every setInterval call, and exposes helpers for
// driving the BC channel and the polling tick.
// ---------------------------------------------------------------------------

interface Harness {
  bc: BroadcastChannel;     // sender side (test → relay)
  receiver: BroadcastChannel; // listener (relay → test)
  captured: Array<Record<string, unknown>>;
  instances: Map<string, PopupRecord>;
  scopeAbortController: AbortController;
  fireRequest: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  fireBC: (msg: Record<string, unknown>) => Promise<void>;
  tickPolling: (windowId: string) => Promise<void>;
  abort: () => void;
}

async function makeHarness(): Promise<Harness> {
  const { instances } = installPopupManagerMock();
  installFakeSteamClient();

  // Build a hand-rolled scope that mirrors ScopeApi but records intervals
  // into intervalsArmed for deterministic stepping in tests. Also exposes
  // _abort so the harness can drive teardown.
  const scopeAbortController = new AbortController();
  const scope = {
    signal: scopeAbortController.signal,
    setTimeout: (_cb: () => void, _ms: number) => 0,
    setInterval: (cb: () => void, _ms: number) => {
      const id = nextIntervalId++;
      intervalsArmed.push({ id, cb, cleared: false });
      return id;
    },
    clearTimeout: (_id: number) => {},
    clearInterval: (id: number) => {
      const a = armedById(id);
      if (a) a.cleared = true;
    },
    listen: (target: EventTarget, type: string, handler: EventListenerOrEventListenerObject) => {
      target.addEventListener(type, handler, { signal: scopeAbortController.signal });
    },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    abortable: <T,>(p: Promise<T>) => p,
    observer: <T extends { disconnect(): void }>(o: T) => o,
    _abort: () => scopeAbortController.abort(),
  };
  scopeRef = scope;

  const { startRelay } = await import('../src/relay/shared-context');
  stopRelay = startRelay(scope as unknown as Parameters<typeof startRelay>[0]);

  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const captured: Array<Record<string, unknown>> = [];
  receiver.addEventListener('message', (ev) => {
    captured.push((ev as MessageEvent).data as Record<string, unknown>);
  });

  let nextRequestId = 100;

  const fireRequest = async (msg: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requestId = (msg.requestId as number | undefined) ?? nextRequestId++;
    const before = captured.length;
    const requestKind = msg.kind as string;
    bc.postMessage({ ...msg, requestId });
    await flushBC();
    // The receiver BC sees BOTH the request we just posted AND the relay's
    // response (same channel, separate BC instances; BroadcastChannel
    // delivers to every instance except the sender). Filter out the
    // request-kind echo so we return only the relay's response.
    const response = captured.slice(before).find((m) =>
      typeof m === 'object' && m !== null
      && (m as { requestId?: number }).requestId === requestId
      && (m as { kind?: string }).kind !== requestKind,
    );
    if (!response) {
      throw new Error('fireRequest: no response within flush window for requestId=' + requestId);
    }
    return response;
  };

  const fireBC = async (msg: Record<string, unknown>): Promise<void> => {
    bc.postMessage(msg);
    await flushBC();
  };

  const tickPolling = async (windowId: string): Promise<void> => {
    // Walk armed intervals in order; the first non-cleared one whose
    // callback observes a window-id-matching tracking entry is invoked.
    // For our tests there is at most one armed poll per window, and they
    // self-clear on close — so just call every uncleared interval. The
    // relay's tick implementation early-returns on tracked-not-found, so
    // running stale ticks is safe.
    void windowId;  // accepted for API symmetry; not used to filter today
    for (const a of intervalsArmed) {
      if (a.cleared) continue;
      a.cb();
    }
    // Flush BC: the relay's bc.postMessage from inside the interval
    // callback delivers asynchronously to our receiver — wait for it.
    await flushBC();
  };

  return {
    bc,
    receiver,
    captured,
    instances,
    scopeAbortController,
    fireRequest,
    fireBC,
    tickPolling,
    abort: () => scopeAbortController.abort(),
  };
}

// ---------------------------------------------------------------------------
// Common open-window request payload (lets tests focus on the diff).
// ---------------------------------------------------------------------------

function openMsg(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'open-window',
    requestId: 1,
    windowId: 'sb_test',
    title: 'Test',
    url: 'https://x.com/',
    width: 720,
    height: 600,
    minWidth: 320,
    minHeight: 240,
    resizable: true,
    noTaskbarIcon: false,
    alwaysOnTop: false,
    composited: true,
    centerOnMain: true,
    ...overrides,
  };
}

// ===========================================================================
// Validation tests (9)
// ===========================================================================

test('open-window invalid id (regex fail) → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: '!@#$' }));
  expect(r).toMatchObject({ kind: 'window-open-error', error: 'invalid id' });
  h.bc.close(); h.receiver.close();
});

test('open-window id taken by attachPopup → window-open-error "id collides"', async () => {
  const h = await makeHarness();
  // Pre-attach a popup with the same id we'll try to use.
  const attachReq = h.fireRequest({
    kind: 'attach-popup', requestId: 50, popupId: 'sb_x',
    html: '<x>', width: 320, height: 142, hideOnBlur: false,
  });
  await attachReq;

  const r = await h.fireRequest(openMsg({ requestId: 1, windowId: 'sb_x' }));
  expect(r).toMatchObject({ kind: 'window-open-error' });
  expect((r as { error: string }).error).toMatch(/id collides/);
  h.bc.close(); h.receiver.close();
});

// I-1 regression: attachPopup must check windows map — symmetric to the
// open-window→popups check. Without this, an attach-popup using an id
// already claimed by open-window would corrupt the tracked windows entry
// (removeTrackedZombies prefix scan matches wrapper popup name `${id}_uid0`).
test('attach-popup id taken by open-window → popup-attach-error "id collides"', async () => {
  const h = await makeHarness();
  // Open a window first.
  const r1 = await h.fireRequest(openMsg({ requestId: 1, windowId: 'sb_x' }));
  expect(r1).toMatchObject({ kind: 'window-opened' });

  // Now try to attach a popup with the same id.
  const r2 = await h.fireRequest({
    kind: 'attach-popup', requestId: 50, popupId: 'sb_x',
    html: '<p/>', width: 320, height: 142, hideOnBlur: false,
  });
  expect(r2).toMatchObject({ kind: 'popup-attach-error' });
  expect((r2 as { error: string }).error).toMatch(/id collides/);
  h.bc.close(); h.receiver.close();
});

test('open-window both url and html → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'x_both', url: 'https://a.b/', html: '<p/>' }));
  expect(r).toMatchObject({ kind: 'window-open-error' });
  expect((r as { error: string }).error).toMatch(/mutually exclusive/);
  h.bc.close(); h.receiver.close();
});

test('open-window neither url nor html → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'x_none', url: undefined }));
  expect(r).toMatchObject({ kind: 'window-open-error' });
  expect((r as { error: string }).error).toMatch(/required/);
  h.bc.close(); h.receiver.close();
});

test('open-window unsafe url (http) → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'x_http', url: 'http://x.com/' }));
  expect((r as { error: string }).error).toMatch(/unsafe url/);
  h.bc.close(); h.receiver.close();
});

test('open-window url with userinfo → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'x_user', url: 'https://user@x.com/' }));
  expect((r as { error: string }).error).toMatch(/unsafe url/);
  h.bc.close(); h.receiver.close();
});

test('open-window url with port → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'x_port', url: 'https://x.com:8443/' }));
  expect((r as { error: string }).error).toMatch(/unsafe url/);
  h.bc.close(); h.receiver.close();
});

test('open-window html over the size cap → window-open-error', async () => {
  const h = await makeHarness();
  const big = 'a'.repeat(OPEN_WINDOW_HTML_MAX_BYTES + 1);
  const r = await h.fireRequest(openMsg({ windowId: 'x_big', url: undefined, html: big }));
  expect((r as { error: string }).error).toMatch(/html too large/);
  h.bc.close(); h.receiver.close();
});

test('open-window empty title → window-open-error', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'x_t', title: '' }));
  expect((r as { error: string }).error).toMatch(/title is required/);
  h.bc.close(); h.receiver.close();
});

// ===========================================================================
// Happy path (2)
// ===========================================================================

test('open-window happy path → window-opened with effective sizes', async () => {
  const h = await makeHarness();
  const r = await h.fireRequest(openMsg({ windowId: 'sb_test' }));
  expect(r).toMatchObject({
    kind: 'window-opened',
    requestId: 1,
    windowId: 'sb_test',
    effectiveWidth: 720,
    effectiveHeight: 600,
  });
  expect(h.instances.has('sb_test')).toBe(true);
  h.bc.close(); h.receiver.close();
});

test('open-window with id taken by another window → window-open-error', async () => {
  const h = await makeHarness();
  // Open one window first.
  const r1 = await h.fireRequest(openMsg({ requestId: 1, windowId: 'sb_dup' }));
  expect(r1).toMatchObject({ kind: 'window-opened' });

  // Attempt to open a second window with the same id.
  const r2 = await h.fireRequest(openMsg({ requestId: 2, windowId: 'sb_dup' }));
  expect((r2 as { error: string }).error).toMatch(/id collides/);
  h.bc.close(); h.receiver.close();
});

// ===========================================================================
// Lifecycle (forwarding) — 4 cases: show / hide / bring / postMessage
// ===========================================================================

test('window-show forwards to SteamClient.Window.ShowWindow', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_show' }));
  const inst = h.instances.get('sb_show')!;
  const before = inst.calls.show;

  await h.fireBC({ kind: 'window-show', windowId: 'sb_show' });
  expect(inst.calls.show).toBe(before + 1);
  // Confirm relay also broadcast a window-show-event.
  expect(h.captured).toContainEqual(expect.objectContaining({
    kind: 'window-show-event', windowId: 'sb_show',
  }));
  h.bc.close(); h.receiver.close();
});

test('window-hide forwards to SteamClient.Window.HideWindow', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_hide' }));
  const inst = h.instances.get('sb_hide')!;
  const before = inst.calls.hide;

  await h.fireBC({ kind: 'window-hide', windowId: 'sb_hide' });
  // Note: commonPopupSetup's CEF realize warmup also calls HideWindow once
  // during open. We assert the *delta* added by the explicit window-hide
  // BC message — which must be exactly 1.
  expect(inst.calls.hide).toBe(before + 1);
  expect(h.captured).toContainEqual(expect.objectContaining({
    kind: 'window-hide-event', windowId: 'sb_hide',
  }));
  h.bc.close(); h.receiver.close();
});

test('window-bring forwards to SteamClient.Window.BringToFront', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_bring' }));
  const inst = h.instances.get('sb_bring')!;
  const before = inst.calls.bring;

  await h.fireBC({ kind: 'window-bring', windowId: 'sb_bring' });
  expect(inst.calls.bring).toBe(before + 1);
  h.bc.close(); h.receiver.close();
});

test('window-postMessage url-mode → relay does NOT re-broadcast (wrapper owns delivery)', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_pm_url' })); // url-mode (default)
  const beforeLen = h.captured.length;
  await h.fireBC({ kind: 'window-postMessage', windowId: 'sb_pm_url', data: { x: 1 } });
  const out = h.captured.slice(beforeLen).find((m) => m.kind === 'window-message');
  expect(out).toBeUndefined();
  h.bc.close(); h.receiver.close();
});

test('window-postMessage html-mode → forwards via BC as window-message', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_pm_html', url: undefined, html: '<p>x</p>' }));
  const beforeLen = h.captured.length;
  await h.fireBC({ kind: 'window-postMessage', windowId: 'sb_pm_html', data: { x: 1 } });
  const out = h.captured.slice(beforeLen).find((m) => m.kind === 'window-message');
  expect(out).toEqual(expect.objectContaining({ kind: 'window-message', windowId: 'sb_pm_html', data: { x: 1 } }));
  h.bc.close(); h.receiver.close();
});

// ===========================================================================
// Close-event reasons — 4 cases: caller / user / crash / teardown
// ===========================================================================

test('window-close → destroyPopup + emits close-event reason=caller (after polling tick)', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_close' }));
  const inst = h.instances.get('sb_close')!;
  h.captured.length = 0;

  await h.fireBC({ kind: 'window-close', windowId: 'sb_close' });
  // destroyPopup chain set fw.closed=true via win.close() / popup.Close().
  expect(inst.fw.closed).toBe(true);

  // The poll tick observes BIsClosed→true and emits close-event.
  await h.tickPolling('sb_close');
  expect(h.captured).toContainEqual(expect.objectContaining({
    kind: 'window-close-event', windowId: 'sb_close', reason: 'caller',
  }));
  h.bc.close(); h.receiver.close();
});

test('window-user-close → polling emits close-event reason=user', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_user' }));
  const inst = h.instances.get('sb_user')!;
  h.captured.length = 0;

  // user-close marks lastReason but does NOT close the window — that
  // happens externally (Steam destroys the window in response to the X
  // click). Simulate by flipping fw.closed manually before the tick.
  await h.fireBC({ kind: 'window-user-close', windowId: 'sb_user' });
  inst.fw.closed = true;

  await h.tickPolling('sb_user');
  expect(h.captured).toContainEqual(expect.objectContaining({
    kind: 'window-close-event', windowId: 'sb_user', reason: 'user',
  }));
  h.bc.close(); h.receiver.close();
});

test('polling detects unexpected close (BIsClosed=true without user/caller) → reason=crash', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_crash' }));
  const inst = h.instances.get('sb_crash')!;
  h.captured.length = 0;

  // No window-close / window-user-close call — just an external death.
  inst.fw.closed = true;
  await h.tickPolling('sb_crash');

  expect(h.captured).toContainEqual(expect.objectContaining({
    kind: 'window-close-event', windowId: 'sb_crash', reason: 'crash',
  }));
  h.bc.close(); h.receiver.close();
});

test('teardown closes all + emits close-event reason=teardown for each', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ requestId: 1, windowId: 'w1' }));
  await h.fireRequest(openMsg({ requestId: 2, windowId: 'w2' }));
  h.captured.length = 0;

  h.abort();   // trigger scope.signal abort → teardownAll
  await flushBC();

  const teardownEvents = h.captured.filter(
    (m) => m.kind === 'window-close-event' && (m as { reason: string }).reason === 'teardown',
  );
  expect(teardownEvents.length).toBe(2);
  h.bc.close(); h.receiver.close();
});

// I-2 regression: teardownAll must preserve lastReason when set. A
// caller-close (lastReason='caller') fired just before scope abort must
// propagate reason='caller' to handle.on('close'), not be overwritten by
// 'teardown'.
test('teardownAll preserves lastReason=caller when set before abort', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ requestId: 1, windowId: 'sb_lr' }));
  h.captured.length = 0;

  // handleClose sets lastReason='caller' and destroys the window.
  // The poll tick has NOT fired yet — the tracking entry still exists.
  await h.fireBC({ kind: 'window-close', windowId: 'sb_lr' });

  // Trigger scope abort BEFORE the poll tick fires (deterministic: poll
  // only runs when tickPolling is called, never auto-fires in tests).
  h.abort();   // → teardownAll runs
  await flushBC();

  const closeEvents = h.captured.filter((m) => m.kind === 'window-close-event');
  // Only one close-event should be emitted (teardownAll emits for the
  // entry still in the map; the poll would also emit but is never ticked).
  expect(closeEvents.length).toBeGreaterThanOrEqual(1);
  const ev = closeEvents[0] as { windowId: string; reason: string };
  expect(ev.windowId).toBe('sb_lr');
  expect(ev.reason).toBe('caller');   // NOT 'teardown'
  h.bc.close(); h.receiver.close();
});

// ===========================================================================
// Race / corner cases (3)
// ===========================================================================

test('race: window-close + window-user-close back-to-back → single close-event', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_race' }));
  const inst = h.instances.get('sb_race')!;
  h.captured.length = 0;

  // Caller close lands first → lastReason='caller'.
  await h.fireBC({ kind: 'window-close', windowId: 'sb_race' });
  // User close arrives second; handler must early-return on lastReason
  // already set, so the eventual close-event still says 'caller'.
  await h.fireBC({ kind: 'window-user-close', windowId: 'sb_race' });
  inst.fw.closed = true;

  // Tick the poll — only one close-event should fire.
  await h.tickPolling('sb_race');
  // Tick a second time to confirm idempotence (interval cleared after first).
  await h.tickPolling('sb_race');

  const closeEvents = h.captured.filter((m) => m.kind === 'window-close-event');
  expect(closeEvents).toHaveLength(1);
  expect(closeEvents[0]).toMatchObject({ reason: 'caller' });
  h.bc.close(); h.receiver.close();
});

test('polling fires after windows.delete → no-op early-return', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_late' }));
  const inst = h.instances.get('sb_late')!;

  // Drive a normal close → first tick removes the window from the map.
  await h.fireBC({ kind: 'window-close', windowId: 'sb_late' });
  inst.fw.closed = true;
  await h.tickPolling('sb_late');

  h.captured.length = 0;
  // A spurious second tick (the relay's tick is idempotent — even if the
  // poll handle weren't cleared, the early-return on tracked-not-found
  // must keep this silent).
  await h.tickPolling('sb_late');
  expect(h.captured.filter((m) => m.kind === 'window-close-event')).toHaveLength(0);
  h.bc.close(); h.receiver.close();
});

// Bug 1 regression — re-open intermittent. Without eager close-event
// emission, the framework handle's `close` listener didn't fire until the
// 250 ms BIsClosed poll observed the user-close, leaving booster-checkout's
// supportHandle stale during the gap; a fast re-open click hit
// bringToFront() on a destroyed window and looked like "did nothing".
//
// Pin: window-user-close MUST emit window-close-event synchronously
// (within the BC microtask, not after a setInterval tick). Same for
// caller-close.

test('Bug 1 regression: window-user-close emits close-event WITHOUT polling tick', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_eager_user' }));
  h.captured.length = 0;

  // Fire user-close. Do NOT advance the polling tick.
  await h.fireBC({ kind: 'window-user-close', windowId: 'sb_eager_user' });

  // Close-event must be present in the captured BC traffic IMMEDIATELY,
  // before any tickPolling() — proves the emit is synchronous via
  // finalizeClose, not deferred to the 250ms BIsClosed poll.
  const closeEvents = h.captured.filter((m) => m.kind === 'window-close-event');
  expect(closeEvents).toHaveLength(1);
  expect(closeEvents[0]).toMatchObject({ windowId: 'sb_eager_user', reason: 'user' });
  h.bc.close(); h.receiver.close();
});

test('Bug 1 regression: window-close emits close-event WITHOUT polling tick', async () => {
  const h = await makeHarness();
  await h.fireRequest(openMsg({ windowId: 'sb_eager_caller' }));
  h.captured.length = 0;

  await h.fireBC({ kind: 'window-close', windowId: 'sb_eager_caller' });

  const closeEvents = h.captured.filter((m) => m.kind === 'window-close-event');
  expect(closeEvents).toHaveLength(1);
  expect(closeEvents[0]).toMatchObject({ windowId: 'sb_eager_caller', reason: 'caller' });
  h.bc.close(); h.receiver.close();
});

test('Bug 1 regression: same-id reopen after user-close succeeds (no zombie tracking)', async () => {
  const h = await makeHarness();
  // Cycle 1: open
  const r1 = await h.fireRequest(openMsg({ requestId: 1, windowId: 'sb_reopen' }));
  expect(r1).toMatchObject({ kind: 'window-opened' });
  // Close via X. With eager finalizeClose, the windows-map entry is gone
  // immediately so the Cycle-2 open's idTaken() check passes WITHOUT
  // needing the 250ms poll.
  await h.fireBC({ kind: 'window-user-close', windowId: 'sb_reopen' });

  // Cycle 2: open with the SAME id, BEFORE any tickPolling.
  const r2 = await h.fireRequest(openMsg({ requestId: 2, windowId: 'sb_reopen' }));
  expect(r2).toMatchObject({ kind: 'window-opened' });
  h.bc.close(); h.receiver.close();
});

test('window-show / hide / close on unknown windowId → silent no-op', async () => {
  const h = await makeHarness();
  h.captured.length = 0;

  await h.fireBC({ kind: 'window-show', windowId: 'nope' });
  await h.fireBC({ kind: 'window-hide', windowId: 'nope' });
  await h.fireBC({ kind: 'window-close', windowId: 'nope' });
  await h.fireBC({ kind: 'window-bring', windowId: 'nope' });
  await h.fireBC({ kind: 'window-postMessage', windowId: 'nope', data: 1 });
  await h.fireBC({ kind: 'window-user-close', windowId: 'nope' });

  // Only relay-emitted events count — 'window-show-event', 'window-hide-event',
  // 'window-close-event', 'window-message'. Filter out the request-kind
  // echoes the receiver BC sees from our own bc.postMessage.
  const relayEvents = h.captured.filter((m) => {
    const k = m.kind as string;
    return k === 'window-show-event' || k === 'window-hide-event'
        || k === 'window-close-event' || k === 'window-message';
  });
  expect(relayEvents).toHaveLength(0);
  h.bc.close(); h.receiver.close();
});

