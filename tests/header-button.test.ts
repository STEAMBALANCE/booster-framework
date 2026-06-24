import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { makeUiApi } from '../src/api/ui';
import { createRegistry } from '../src/registry';
import { RELAY_CHANNEL } from '../src/relay/protocol';

// setup() (called per test) assigns happy-dom's window/document/MutationObserver
// onto globalThis. Capture + restore around each test so later test files in
// the same bun worker (e.g. tabbed-shell-controller, which stubs document.head
// by hand) don't trip over happy-dom's MutationObserver internals.
let _origWindow: unknown, _origDocument: unknown, _origMutationObserver: unknown;
beforeEach(() => {
  _origWindow = globalThis.window;
  _origDocument = globalThis.document;
  _origMutationObserver = globalThis.MutationObserver;
});
afterEach(() => {
  // @ts-expect-error
  globalThis.window = _origWindow;
  // @ts-expect-error
  globalThis.document = _origDocument;
  // @ts-expect-error
  globalThis.MutationObserver = _origMutationObserver;
});

function setup() {
  const win = new Window();
  // happy-dom 20 doesn't populate window.SyntaxError; its query-selector
  // parser throws if absent. Patch with the JS-builtin so selectors resolve.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win;
  // @ts-expect-error
  globalThis.document = win.document;
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
  // Build a proper toolbar matching waitForToolbar's structural selector:
  // parent element with >=3 .Focusable children, one of which contains .avatarHolder.
  const toolbar = win.document.createElement('div');
  toolbar.id = 'toolbar';
  for (const which of ['voice', 'profile', 'notif']) {
    const f = win.document.createElement('div');
    f.className = 'Focusable';
    f.setAttribute('data-which', which);
    if (which === 'profile') {
      const a = win.document.createElement('div');
      a.className = 'avatarHolder';
      f.appendChild(a);
    }
    toolbar.appendChild(f);
  }
  win.document.body.appendChild(toolbar);
  return { bridge: { call: async () => ({}) } as any, registry: createRegistry() };
}

test('addHeaderButton with both onClick AND togglePopup throws synchronously', () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  const fakePopup = { width: 320, toggle: () => {} } as any;
  expect(() => ui.addHeaderButton({
    id: 'b1', label: 'X',
    onClick: () => {},
    togglePopup: fakePopup,
  })).toThrow(/exactly one of onClick or togglePopup/);
});

test('addHeaderButton with neither onClick nor togglePopup throws', () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  expect(() => ui.addHeaderButton({ id: 'b1', label: 'X' } as any)).toThrow(/exactly one of onClick or togglePopup/);
});

test('addHeaderButton with togglePopup → click calls popup.toggle with screen coords', async () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);

  const toggleCalls: Array<{ x: number; y: number }> = [];
  const fakePopup = {
    width: 320,
    height: 142,
    toggle: (at: { x: number; y: number }) => { toggleCalls.push(at); },
  } as any;

  ui.addHeaderButton({ id: 'b1', label: 'Click', togglePopup: fakePopup });
  await new Promise((r) => setTimeout(r, 30));   // toolbar wait

  const btn = document.getElementById('b1')!;
  btn.click();
  await new Promise((r) => setTimeout(r, 5));

  expect(toggleCalls.length).toBe(1);
  // x = screenX + rect.right - popup.width; y = screenY + rect.bottom.
  // In happy-dom, getBoundingClientRect returns zeros, screenX/screenY default 0.
  // So: x = 0 + 0 - 320 = -320, y = 0 + 0 = 0.
  expect(typeof toggleCalls[0]!.x).toBe('number');
  expect(typeof toggleCalls[0]!.y).toBe('number');
});

// ── New tests — variant + icon coverage (per phase-b plan) ──
// Reuse the existing setup() helper above; ui is constructed from
// the returned { bridge, registry } per the prevailing pattern in
// this file (setup() does not currently return ui).

test('addHeaderButton with variant:brand sets data-booster-variant attribute', async () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  ui.addHeaderButton({
    id: 'booster-test-brand', label: 'Тест', variant: 'brand', onClick: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));   // toolbar wait
  const el = document.getElementById('booster-test-brand');
  expect(el?.getAttribute('data-booster-variant')).toBe('brand');
});

test('addHeaderButton without variant has NO data-booster-variant attribute', async () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  ui.addHeaderButton({ id: 'booster-test-default', label: 'Тест', onClick: () => {} });
  await new Promise((r) => setTimeout(r, 30));
  const el = document.getElementById('booster-test-default');
  expect(el?.getAttribute('data-booster-variant')).toBeNull();
});

test('addHeaderButton with icon (data:image/...) renders <img>', async () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  ui.addHeaderButton({
    id: 'booster-test-img', label: 'Тест',
    icon: 'data:image/png;base64,iVBORw0KGgo=', onClick: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  const el = document.getElementById('booster-test-img');
  const iconSpan = el?.querySelector('.booster-toolbar-icon');
  const img = iconSpan?.querySelector('img') as HTMLImageElement | null;
  expect(img).not.toBeNull();
  expect(img?.src).toBe('data:image/png;base64,iVBORw0KGgo=');
});

test('addHeaderButton with icon (<svg ...>) renders inline SVG', async () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  const svgString = '<svg viewBox="0 0 8 8"><path d="M0 0"/></svg>';
  ui.addHeaderButton({
    id: 'booster-test-svg', label: 'Тест', icon: svgString, onClick: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  const el = document.getElementById('booster-test-svg');
  const iconSpan = el?.querySelector('.booster-toolbar-icon');
  expect(iconSpan?.querySelector('svg')).not.toBeNull();
});

// Regression test: handle.setLabel() must NOT wipe the icon sibling.
// Without the labelSpan-targeted setLabel, this would silently break.
test('setLabel preserves icon span sibling (regression coverage)', async () => {
  const { bridge, registry } = setup();
  const ui = makeUiApi(registry, bridge);
  const handle = ui.addHeaderButton({
    id: 'booster-test-setlabel',
    label: 'Старый',
    icon: '<svg viewBox="0 0 8 8"><path d="M0 0"/></svg>',
    onClick: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  handle.setLabel('Новый');
  const el = document.getElementById('booster-test-setlabel');
  expect(el?.querySelector('.booster-toolbar-label')?.textContent).toBe('Новый');
  expect(el?.querySelector('.booster-toolbar-icon svg')).not.toBeNull();
});
