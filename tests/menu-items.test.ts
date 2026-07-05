import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { createScope } from '../src/api/scope';
import { createMenuItemsManager } from '../src/relay/menu-items';
import type { AddMenuItemRequest } from '../src/relay/protocol';

let _orig: { window: unknown; document: unknown; mo: unknown; dp: unknown };
beforeEach(() => {
  _orig = {
    window: globalThis.window,
    document: globalThis.document,
    mo: globalThis.MutationObserver,
    dp: (globalThis as { DOMParser?: unknown }).DOMParser,
  };
});
afterEach(() => {
  // @ts-expect-error restore
  globalThis.window = _orig.window;
  // @ts-expect-error restore
  globalThis.document = _orig.document;
  // @ts-expect-error restore
  globalThis.MutationObserver = _orig.mo;
  (globalThis as { DOMParser?: unknown }).DOMParser = _orig.dp;
});

function setup(opts?: { title?: string; withNativeItem?: boolean }) {
  const win = new Window();
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error assign happy-dom globals
  globalThis.window = win;
  // @ts-expect-error
  globalThis.document = win.document;
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
  (globalThis as { DOMParser?: unknown }).DOMParser = (win as unknown as { DOMParser: unknown }).DOMParser;

  win.document.title = opts?.title ?? 'Store Supernav';
  const list = win.document.createElement('div');
  list.className = 'menu-list';
  if (opts?.withNativeItem !== false) {
    const native = win.document.createElement('div');
    // Hashed CSS-module classes + the stable contextMenuItem hook, as observed live.
    native.className = '_hashA _hashB _1n7Wxyz contextMenuItem';
    native.setAttribute('role', 'menuitem');
    native.textContent = 'Popular';
    list.appendChild(native);
  }
  win.document.body.appendChild(list);

  const showCalls: string[] = [];
  const loadCalls: string[] = [];
  (win as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager = {
    ShowURL: (u: string) => showCalls.push(u),
    LoadURL: (u: string) => loadCalls.push(u),
  };
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = {
    m_mapPopups: new Map([['contextmenu_9_uid0', { m_popup: { document: win.document } }]]),
  };

  const posts: Array<Record<string, unknown>> = [];
  const scope = createScope();
  const mgr = createMenuItemsManager({ post: (m) => posts.push(m as Record<string, unknown>), scope });
  return { win, list, showCalls, loadCalls, posts, scope, mgr };
}

function addReq(over: Partial<AddMenuItemRequest> = {}): AddMenuItemRequest {
  return {
    kind: 'add-menu-item', requestId: 1, menuItemId: 'plug__catalog', menu: 'store',
    label: 'Catalog', url: 'https://example.com/catalog',
    variant: 'brand', placement: 'top', ...over,
  };
}

test('handleAdd injects the item at the top with the native class cloned', () => {
  const { win, list, posts, scope, mgr } = setup();
  mgr.handleAdd(addReq());

  const el = list.querySelector('[data-sb-menu-item-id="plug__catalog"]') as HTMLElement;
  expect(el).not.toBeNull();
  expect(list.firstElementChild).toBe(el);                 // placement: top
  expect(el.getAttribute('role')).toBe('menuitem');
  expect(el.className).toContain('contextMenuItem');       // cloned native class → 1:1 look
  expect(el.textContent).toContain('Catalog');
  expect(posts.some((p) => p.kind === 'menu-item-added' && p.requestId === 1)).toBe(true);
  scope._abort();
});

test('brand variant injects the idle + hover colour rules', () => {
  const { win, scope, mgr } = setup();
  mgr.handleAdd(addReq({ variant: 'brand' }));
  const style = win.document.getElementById('sb-mi-style-plug__catalog');
  expect(style).not.toBeNull();
  const css = style!.textContent ?? '';
  expect(css).toContain('#34A37B33'); // idle bg
  expect(css).toContain('#93E0AD');   // idle text/icon
  expect(css).toContain('#DCDEDF');   // hover bg (native item look)
  expect(css).toContain('#3D4450');   // hover text
  scope._abort();
});

test('default variant does NOT inject colour overrides', () => {
  const { win, scope, mgr } = setup();
  mgr.handleAdd(addReq({ variant: 'default' }));
  const css = win.document.getElementById('sb-mi-style-plug__catalog')!.textContent ?? '';
  expect(css).not.toContain('#93E0AD');
  scope._abort();
});

test('click navigates the main window via ShowURL (switches view + loads)', () => {
  const { list, showCalls, loadCalls, scope, mgr } = setup();
  mgr.handleAdd(addReq());
  const el = list.querySelector('[data-sb-menu-item-id="plug__catalog"]') as HTMLElement;
  el.click();
  // ShowURL is preferred: it switches the router to /browser/ AND loads (works
  // from the Library view). LoadURL alone would not switch views.
  expect(showCalls).toEqual(['https://example.com/catalog']);
  expect(loadCalls).toEqual([]);
  scope._abort();
});

test('click falls back to LoadURL when ShowURL is unavailable (older client)', () => {
  const { win, list, loadCalls, scope, mgr } = setup();
  (win as unknown as { MainWindowBrowserManager: { ShowURL?: unknown } }).MainWindowBrowserManager.ShowURL = undefined;
  mgr.handleAdd(addReq());
  const el = list.querySelector('[data-sb-menu-item-id="plug__catalog"]') as HTMLElement;
  el.click();
  expect(loadCalls).toEqual(['https://example.com/catalog']);
  scope._abort();
});

test('icon SVG is sanitized — script / on* never reach the DOM', () => {
  const { list, scope, mgr } = setup();
  mgr.handleAdd(addReq({
    iconSvg: '<svg viewBox="0 0 10 10"><path d="M0 0h10" fill="currentColor"/>'
      + '<script>window.__pwned=1</script><path onload="alert(1)" d="M1 1"/></svg>',
  }));
  const icon = list.querySelector('.sb-menu-item-icon');
  expect(icon).not.toBeNull();
  expect(icon!.querySelector('script')).toBeNull();       // dropped tag
  expect(icon!.innerHTML).not.toContain('__pwned');
  expect(icon!.innerHTML).not.toContain('onload');        // dropped attr
  scope._abort();
});

test('data: image icon is rendered as <img>, not inline SVG', () => {
  const { list, scope, mgr } = setup();
  mgr.handleAdd(addReq({ iconSvg: 'data:image/png;base64,iVBORw0KGgo=' }));
  const icon = list.querySelector('.sb-menu-item-icon')!;
  const img = icon.querySelector('img') as HTMLImageElement | null;
  expect(img).not.toBeNull();
  expect(img!.getAttribute('src')).toContain('data:image/png');
  scope._abort();
});

test('handleRemove removes the item and its style', () => {
  const { win, list, scope, mgr } = setup();
  mgr.handleAdd(addReq());
  mgr.handleRemove({ kind: 'remove-menu-item', menuItemId: 'plug__catalog' });
  expect(list.querySelector('[data-sb-menu-item-id="plug__catalog"]')).toBeNull();
  expect(win.document.getElementById('sb-mi-style-plug__catalog')).toBeNull();
  scope._abort();
});

test('placement bottom appends after native items', () => {
  const { list, scope, mgr } = setup();
  mgr.handleAdd(addReq({ placement: 'bottom' }));
  const el = list.querySelector('[data-sb-menu-item-id="plug__catalog"]');
  expect(list.lastElementChild).toBe(el);
  scope._abort();
});

test('re-add with the same id rebuilds without duplicating', () => {
  const { list, scope, mgr } = setup();
  mgr.handleAdd(addReq({ label: 'Catalog' }));
  mgr.handleAdd(addReq({ label: 'Catalog v2' }));
  const all = list.querySelectorAll('[data-sb-menu-item-id="plug__catalog"]');
  expect(all.length).toBe(1);
  expect((all[0] as HTMLElement).textContent).toContain('v2');
  scope._abort();
});

test('rejects an unsafe (non-https) url', () => {
  const { list, posts, scope, mgr } = setup();
  mgr.handleAdd(addReq({ url: 'http://example.com/x' }));
  expect(list.querySelector('[data-sb-menu-item-id="plug__catalog"]')).toBeNull();
  expect(posts.some((p) => p.kind === 'menu-item-error')).toBe(true);
  scope._abort();
});

test('invalid menu name is rejected', () => {
  const { posts, scope, mgr } = setup();
  // @ts-expect-error deliberately invalid
  mgr.handleAdd(addReq({ menu: 'nope' }));
  expect(posts.some((p) => p.kind === 'menu-item-error')).toBe(true);
  scope._abort();
});

test('no-op when the target popup is not present', () => {
  const { win, scope, mgr, posts } = setup();
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = { m_mapPopups: new Map() };
  mgr.handleAdd(addReq());
  // Intent is still registered (added reply) even though nothing was injected.
  expect(posts.some((p) => p.kind === 'menu-item-added')).toBe(true);
  scope._abort();
});

test('MutationObserver re-injects the item after a re-render wipes it', async () => {
  const { list, scope, mgr } = setup();
  mgr.handleAdd(addReq());
  const el = list.querySelector('[data-sb-menu-item-id="plug__catalog"]') as HTMLElement;
  expect(el).not.toBeNull();
  el.remove(); // simulate React wiping our foreign node — a childList mutation
  await new Promise((r) => setTimeout(r, 40));
  expect(list.querySelector('[data-sb-menu-item-id="plug__catalog"]')).not.toBeNull();
  scope._abort();
});

test('reconcile interval injects once the target popup appears later', async () => {
  const { win, list, scope, mgr } = setup();
  // Popup absent at add-time → initial reconcile injects nothing.
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = { m_mapPopups: new Map() };
  mgr.handleAdd(addReq());
  expect(list.querySelector('[data-sb-menu-item-id="plug__catalog"]')).toBeNull();
  // Popup appears; the persistent interval (~800ms) should pick it up.
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = {
    m_mapPopups: new Map([['cm', { m_popup: { document: win.document } }]]),
  };
  await new Promise((r) => setTimeout(r, 950));
  expect(list.querySelector('[data-sb-menu-item-id="plug__catalog"]')).not.toBeNull();
  scope._abort();
});

test('teardown removes every managed item and its style', () => {
  const { win, list, scope, mgr } = setup();
  mgr.handleAdd(addReq({ menuItemId: 'plug__a', requestId: 1 }));
  mgr.handleAdd(addReq({ menuItemId: 'plug__b', requestId: 2 }));
  expect(list.querySelectorAll('[data-sb-menu-item-id]').length).toBe(2);
  mgr.teardown();
  expect(list.querySelectorAll('[data-sb-menu-item-id]').length).toBe(0);
  expect(win.document.getElementById('sb-mi-style-plug__a')).toBeNull();
  expect(win.document.getElementById('sb-mi-style-plug__b')).toBeNull();
  scope._abort();
});

test('findPopupDoc tolerates null m_popup and throwing document access', () => {
  const { win, list, scope, mgr } = setup();
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = {
    m_mapPopups: new Map<string, unknown>([
      ['dead', { m_popup: null }],
      ['throws', { get m_popup() { throw new Error('cross-realm'); } }],
      ['real', { m_popup: { document: win.document } }],
    ]),
  };
  expect(() => mgr.handleAdd(addReq())).not.toThrow();
  expect(list.querySelector('[data-sb-menu-item-id="plug__catalog"]')).not.toBeNull();
  scope._abort();
});

test('sanitizer strips use / image / anchor / href / url() refs', () => {
  const { list, scope, mgr } = setup();
  mgr.handleAdd(addReq({
    iconSvg:
      '<svg viewBox="0 0 10 10">'
      + '<use href="#x"/><use xlink:href="#y"/>'
      + '<image href="https://evil.example/x.png"/>'
      + '<a href="https://evil.example"><path d="M0 0"/></a>'
      + '<path d="M1 1" fill="url(#grad)"/>'
      + '</svg>',
  }));
  const icon = list.querySelector('.sb-menu-item-icon')!;
  expect(icon.querySelector('use')).toBeNull();
  expect(icon.querySelector('image')).toBeNull();
  expect(icon.querySelector('a')).toBeNull();
  expect(icon.innerHTML).not.toContain('evil');
  expect(icon.innerHTML.toLowerCase()).not.toContain('xlink');
  const p = icon.querySelector('path');           // the last, non-anchored path survives
  expect(p).not.toBeNull();
  expect(p!.getAttribute('fill')).toBeNull();      // url(#grad) value dropped
  scope._abort();
});

test('re-add with a changed menu moves the item to the new popup (no orphan)', () => {
  const { win, list: storeList, scope, mgr } = setup(); // title 'Store Supernav'
  // Second popup doc for the library supernav.
  const libWin = new Window();
  (libWin as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  libWin.document.title = 'Library Supernav';
  const libList = libWin.document.createElement('div');
  const libNative = libWin.document.createElement('div');
  libNative.className = '_1n7Wxyz contextMenuItem';
  libNative.textContent = 'Home';
  libList.appendChild(libNative);
  libWin.document.body.appendChild(libList);
  (win as unknown as { g_PopupManager: { m_mapPopups: Map<string, unknown> } })
    .g_PopupManager.m_mapPopups.set('lib', { m_popup: { document: libWin.document } });

  mgr.handleAdd(addReq({ menu: 'store' }));
  expect(storeList.querySelector('[data-sb-menu-item-id="plug__catalog"]')).not.toBeNull();

  mgr.handleAdd(addReq({ menu: 'library' }));
  expect(storeList.querySelector('[data-sb-menu-item-id="plug__catalog"]')).toBeNull(); // old node removed
  expect(libList.querySelector('[data-sb-menu-item-id="plug__catalog"]')).not.toBeNull();
  scope._abort();
});
