// framework/tests/open-window.test.ts
//
// Tests for sb.ui.openWindow API on the framework (MainShell) side.
// Harness pattern follows ui.test.ts: fresh happy-dom Window per test,
// fake bridge/registry, and a separate BroadcastChannel(RELAY_CHANNEL)
// instance acting as the "fake relay" — the framework posts requests
// on RELAY_CHANNEL; the test listens and posts responses back.
//
// Coverage layout (~33 cases):
//   • Validation         — sync throws (id, url/html mutex, title, url
//                          safety, html size, finite width/height).
//   • Roundtrip          — BC posts include url/html; resolves on
//                          window-opened; rejects on window-open-error
//                          and on timeout.
//   • Handle methods     — show / hide / close / bringToFront /
//                          setTitle / postMessage (html-/url-mode).
//   • Event listeners    — on('show'|'hide'|'close'|'message').
//   • Lifecycle          — methods after close = no-op; rollbackAll
//                          closes opened windows.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { OPEN_WINDOW_HTML_MAX_BYTES } from '../src/relay/protocol';

let win: Window;

// afterEach restores the captured originals — happy-dom's MutationObserver
// otherwise leaks for the rest of the bun worker and poisons later test files
// that stub document.head by hand (e.g. tabbed-shell-controller).
let _origWindow: unknown, _origDocument: unknown, _origMutationObserver: unknown;
beforeEach(() => {
  _origWindow = globalThis.window;
  _origDocument = globalThis.document;
  _origMutationObserver = globalThis.MutationObserver;
  win = new Window();
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error - assign happy-dom Window to globalThis
  globalThis.window = win;
  // @ts-expect-error - document/MutationObserver come from happy-dom Window
  globalThis.document = win.document;
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
});
afterEach(() => {
  // @ts-expect-error
  globalThis.window = _origWindow;
  // @ts-expect-error
  globalThis.document = _origDocument;
  // @ts-expect-error
  globalThis.MutationObserver = _origMutationObserver;
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeFixture() {
  const { RELAY_CHANNEL } = await import('../src/relay/protocol');
  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');

  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  // Fake relay BC — listens to whatever the framework posts and lets the
  // test push replies/events back into the framework.
  const fakeRelay = new BroadcastChannel(RELAY_CHANNEL);
  const seen: Array<Record<string, unknown>> = [];
  fakeRelay.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    seen.push(m);
  });

  return { reg, ui, fakeRelay, seen };
}

function autoOpenedAck(fakeRelay: BroadcastChannel, seen: Array<Record<string, unknown>>) {
  // When the framework posts an 'open-window' request, immediately reply
  // with a 'window-opened' response so the openWindow promise resolves.
  fakeRelay.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    if (m['kind'] !== 'open-window') return;
    fakeRelay.postMessage({
      kind: 'window-opened',
      requestId: m['requestId'],
      windowId: m['windowId'],
      effectiveWidth:  m['width'],
      effectiveHeight: m['height'],
    });
  });
  return seen;
}

// ── Validation tests (sync throws — no relay needed) ───────────────────────

test('openWindow throws on missing url and html', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({ id: 'w1', title: 't', width: 800, height: 600 })
  ).rejects.toThrow(/either url or html/);
});

test('openWindow throws on both url and html', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({
      id: 'w1', title: 't',
      url: 'https://example.com/', html: '<p>x</p>',
      width: 800, height: 600,
    })
  ).rejects.toThrow(/mutually exclusive/);
});

test('openWindow throws on invalid id (regex fail)', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({ id: 'bad/id', title: 't', html: '<p>x</p>', width: 800, height: 600 })
  ).rejects.toThrow(/invalid id/);
});

test('openWindow throws on missing title', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({ id: 'w1', title: '', html: '<p>x</p>', width: 800, height: 600 })
  ).rejects.toThrow(/title is required/);
});

test('openWindow throws on unsafe url (http)', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({ id: 'w1', title: 't', url: 'http://example.com/', width: 800, height: 600 })
  ).rejects.toThrow(/unsafe url/);
});

test('openWindow throws on url with userinfo', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({
      id: 'w1', title: 't',
      url: 'https://user:pass@example.com/',
      width: 800, height: 600,
    })
  ).rejects.toThrow(/unsafe url/);
});

test('openWindow throws on url with explicit port', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({
      id: 'w1', title: 't',
      url: 'https://example.com:8443/',
      width: 800, height: 600,
    })
  ).rejects.toThrow(/unsafe url/);
});

test('openWindow throws on non-finite width', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({ id: 'w1', title: 't', html: '<p>x</p>', width: NaN, height: 600 })
  ).rejects.toThrow(/invalid width/);
});

test('openWindow throws on non-finite height', async () => {
  const { ui } = await makeFixture();
  await expect(
    ui.openWindow({ id: 'w1', title: 't', html: '<p>x</p>', width: 800, height: Infinity })
  ).rejects.toThrow(/invalid height/);
});

test('openWindow throws on html over the size cap', async () => {
  const { ui } = await makeFixture();
  // One byte over the cap; 'a' is 1 byte UTF-8. Robust to the limit value.
  const big = 'a'.repeat(OPEN_WINDOW_HTML_MAX_BYTES + 1);
  await expect(
    ui.openWindow({ id: 'w1', title: 't', html: big, width: 800, height: 600 })
  ).rejects.toThrow(/html too large/);
});

// ── Roundtrip tests ────────────────────────────────────────────────────────

test('openWindow url-mode posts open-window BC with url', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  await ui.openWindow({
    id: 'w_url', title: 'T', url: 'https://example.com/page',
    width: 800, height: 600,
  });

  const req = seen.find((m) => m['kind'] === 'open-window');
  expect(req).toBeDefined();
  expect(req?.['windowId']).toBe('w_url');
  expect(req?.['url']).toBe('https://example.com/page');
  expect(req?.['html']).toBeUndefined();
  expect(req?.['title']).toBe('T');
  expect(req?.['width']).toBe(800);
  expect(req?.['height']).toBe(600);

  fakeRelay.close();
});

test('openWindow html-mode posts open-window BC with html', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  await ui.openWindow({
    id: 'w_html', title: 'T', html: '<h1>hi</h1>',
    width: 800, height: 600,
  });

  const req = seen.find((m) => m['kind'] === 'open-window');
  expect(req).toBeDefined();
  expect(req?.['windowId']).toBe('w_html');
  expect(req?.['html']).toBe('<h1>hi</h1>');
  expect(req?.['url']).toBeUndefined();

  fakeRelay.close();
});

test('openWindow returns handle after window-opened response', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_ok', title: 'T', html: '<p>x</p>',
    width: 800, height: 600,
  });

  expect(handle.id).toBe('w_ok');
  expect(handle.width).toBe(800);
  expect(handle.height).toBe(600);
  expect(handle.isVisible()).toBe(false);
  expect(typeof handle.show).toBe('function');
  expect(typeof handle.close).toBe('function');

  fakeRelay.close();
});

test('openWindow rejects after window-open-error response', async () => {
  const { ui, fakeRelay } = await makeFixture();

  fakeRelay.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    if (m['kind'] !== 'open-window') return;
    fakeRelay.postMessage({
      kind: 'window-open-error',
      requestId: m['requestId'],
      windowId: m['windowId'],
      error: 'simulated relay error',
    });
  });

  await expect(
    ui.openWindow({ id: 'w_err', title: 'T', html: '<p>x</p>', width: 800, height: 600 })
  ).rejects.toThrow(/simulated relay error/);

  fakeRelay.close();
});

test('openWindow rejects after timeout (no relay reply)', async () => {
  // Mock setTimeout to fast-forward the 5s attach timer instead of waiting
  // 5 real seconds. Bun's `setTimeout` is the global; happy-dom doesn't
  // override it. We swap globalThis.setTimeout so attachRequest's timer
  // fires immediately while leaving Promise microtasks queued normally.
  const realSetTimeout = globalThis.setTimeout;
  // @ts-expect-error - simplified mock signature
  globalThis.setTimeout = ((fn: () => void, _ms: number) => {
    return realSetTimeout(fn, 0);
  });

  try {
    const { ui, fakeRelay } = await makeFixture();
    // No listener handlers — relay never replies.

    await expect(
      ui.openWindow({ id: 'w_to', title: 'T', html: '<p>x</p>', width: 800, height: 600 })
    ).rejects.toThrow(/timeout/);

    fakeRelay.close();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ── Handle methods ─────────────────────────────────────────────────────────

test('handle.show posts window-show BC', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_s', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  handle.show();
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-show');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_s');

  fakeRelay.close();
});

test('handle.hide posts window-hide BC', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_h', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  handle.hide();
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-hide');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_h');

  fakeRelay.close();
});

test('handle.close posts window-close BC + cleans up registry', async () => {
  const { reg, ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const sizeBefore = reg.size();
  const handle = await ui.openWindow({
    id: 'w_c', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  expect(reg.size()).toBe(sizeBefore + 1); // one undo entry per open window

  handle.close();
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-close');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_c');
  // After close, the per-window registry entry is removed.
  expect(reg.size()).toBe(sizeBefore);

  fakeRelay.close();
});

test('handle.bringToFront posts window-bring BC', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_b', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  handle.bringToFront();
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-bring');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_b');

  fakeRelay.close();
});

test('handle.setTitle posts window-set-title BC (wrapper-direct)', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_t', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  handle.setTitle('новый заголовок');
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-set-title');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_t');
  expect(msg?.['title']).toBe('новый заголовок');

  fakeRelay.close();
});

test('handle.postMessage in html-mode posts window-postMessage BC', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_pm', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  handle.postMessage({ kind: 'ping', n: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-postMessage');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_pm');
  expect(msg?.['data']).toEqual({ kind: 'ping', n: 1 });

  fakeRelay.close();
});

test('handle.postMessage in url-mode posts window-postMessage (bridged to iframe)', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_url_pm', title: 'T', url: 'https://example.com/',
    width: 800, height: 600,
  });
  handle.postMessage({ kind: 'ping', n: 2 });
  await new Promise((r) => setTimeout(r, 10));

  const msg = seen.find((m) => m['kind'] === 'window-postMessage');
  expect(msg).toBeDefined();
  expect(msg?.['windowId']).toBe('w_url_pm');
  expect(msg?.['data']).toEqual({ kind: 'ping', n: 2 });

  fakeRelay.close();
});

test('handle.postMessage drops payload over WINDOW_MESSAGE_MAX_BYTES', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_cap', title: 'T', url: 'https://example.com/', width: 400, height: 300,
  });
  handle.postMessage({ big: 'x'.repeat(20000) });
  await new Promise((r) => setTimeout(r, 10));

  expect(seen.find((m) => m['kind'] === 'window-postMessage')).toBeUndefined();
  fakeRelay.close();
});

test('openWindow forwards embedOrigins in open-window request', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  await ui.openWindow({
    id: 'w_eo', title: 'T', url: 'https://example.com/', width: 400, height: 300,
    embedOrigins: ['https://pay.steambalance.cc'],
  });
  await new Promise((r) => setTimeout(r, 10));

  const open = seen.find((m) => m['kind'] === 'open-window');
  expect(open?.['embedOrigins']).toEqual(['https://pay.steambalance.cc']);
  fakeRelay.close();
});

// ── Event listeners ────────────────────────────────────────────────────────

test("handle.on('close') fires on window-close-event", async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_oncl', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  let reason: unknown = undefined;
  handle.on('close', (r) => { reason = r; });

  fakeRelay.postMessage({
    kind: 'window-close-event', windowId: 'w_oncl', reason: 'user',
  });
  await new Promise((r) => setTimeout(r, 30));

  expect(reason).toBe('user');

  fakeRelay.close();
});

test("handle.on('message') fires on window-message event", async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_onm', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  let received: unknown = undefined;
  handle.on('message', (d) => { received = d; });

  fakeRelay.postMessage({
    kind: 'window-message', windowId: 'w_onm', data: { tag: 'hi' },
  });
  await new Promise((r) => setTimeout(r, 30));

  expect(received).toEqual({ tag: 'hi' });

  fakeRelay.close();
});

test("handle.on('show')/('hide') fires on respective events; isVisible tracks", async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_onsh', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });
  let shown = 0, hidden = 0;
  handle.on('show', () => { shown++; });
  handle.on('hide', () => { hidden++; });

  expect(handle.isVisible()).toBe(false);

  fakeRelay.postMessage({ kind: 'window-show-event', windowId: 'w_onsh' });
  await new Promise((r) => setTimeout(r, 30));
  expect(shown).toBe(1);
  expect(handle.isVisible()).toBe(true);

  fakeRelay.postMessage({ kind: 'window-hide-event', windowId: 'w_onsh' });
  await new Promise((r) => setTimeout(r, 30));
  expect(hidden).toBe(1);
  expect(handle.isVisible()).toBe(false);

  fakeRelay.close();
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('handle methods after close = silent no-op', async () => {
  const { ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);

  const handle = await ui.openWindow({
    id: 'w_dead', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });

  // Simulate a relay-driven close-event so the local `closed` flag flips.
  fakeRelay.postMessage({
    kind: 'window-close-event', windowId: 'w_dead', reason: 'user',
  });
  await new Promise((r) => setTimeout(r, 30));

  // Snapshot BC traffic before issuing post-close calls; nothing new should
  // appear from these invocations.
  const before = seen.filter((m) =>
    m['kind'] === 'window-show' ||
    m['kind'] === 'window-hide' ||
    m['kind'] === 'window-bring' ||
    m['kind'] === 'window-set-title' ||
    m['kind'] === 'window-close' ||
    m['kind'] === 'window-postMessage'
  ).length;

  handle.show();
  handle.hide();
  handle.bringToFront();
  handle.setTitle('ignored');
  handle.postMessage({ x: 1 });
  handle.close();
  await new Promise((r) => setTimeout(r, 20));

  const after = seen.filter((m) =>
    m['kind'] === 'window-show' ||
    m['kind'] === 'window-hide' ||
    m['kind'] === 'window-bring' ||
    m['kind'] === 'window-set-title' ||
    m['kind'] === 'window-close' ||
    m['kind'] === 'window-postMessage'
  ).length;

  expect(after).toBe(before);

  fakeRelay.close();
});

test('rollbackAll closes opened windows (LIFO with attachPopup)', async () => {
  const { reg, ui, fakeRelay, seen } = await makeFixture();
  autoOpenedAck(fakeRelay, seen);
  // Also auto-ack attach-popup so attachPopup resolves alongside openWindow.
  fakeRelay.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    if (m['kind'] !== 'attach-popup') return;
    fakeRelay.postMessage({
      kind: 'popup-attached',
      requestId: m['requestId'],
      popupId: m['popupId'],
    });
  });

  // Open a popup first, then a window — so the registry has popup-undo
  // BEFORE the window-undo. rollbackAll runs LIFO: window first, then popup.
  await ui.attachPopup({ id: 'p_first', html: '<p>p</p>', width: 100, height: 100 });
  await ui.openWindow({
    id: 'w_last', title: 'T', html: '<p>x</p>', width: 800, height: 600,
  });

  // Clear traffic captured during open.
  seen.length = 0;

  reg.rollbackAll();
  await new Promise((r) => setTimeout(r, 30));

  // Both teardown BC posts should have fired; window-close before
  // popup-destroy (LIFO).
  const closeIdx   = seen.findIndex((m) => m['kind'] === 'window-close');
  const destroyIdx = seen.findIndex((m) => m['kind'] === 'popup-destroy');
  expect(closeIdx).toBeGreaterThanOrEqual(0);
  expect(destroyIdx).toBeGreaterThanOrEqual(0);
  expect(closeIdx).toBeLessThan(destroyIdx);

  // Registry fully drained.
  expect(reg.size()).toBe(0);

  fakeRelay.close();
});
