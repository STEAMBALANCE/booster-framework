import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { makeUiApi } from '../src/api/ui';
import { createRegistry, type Registry } from '../src/registry';

let _w: unknown, _d: unknown, _mo: unknown, _dp: unknown;
// CRITICAL: capture the per-test registry so afterEach can tear down every
// button. Without this, each addStoreNavButton leaks a setInterval(reconcile,
// 800) that reads the GLOBAL document; bun runs all test files in one process
// with shared timers, so a leaked interval fires during a LATER file after this
// file's afterEach restored globalThis.document to undefined → a spurious
// TypeError attributed to an unrelated test. rollbackAll() fires each button's
// teardown (clearInterval + observer.disconnect + button.remove).
let _reg: Registry | undefined;
beforeEach(() => { _w = globalThis.window; _d = globalThis.document; _mo = globalThis.MutationObserver; _dp = (globalThis as any).DOMParser; });
afterEach(() => {
  try { _reg?.rollbackAll(); } catch { /* */ }
  _reg = undefined;
  // @ts-expect-error
  globalThis.window = _w; // @ts-expect-error
  globalThis.document = _d; // @ts-expect-error
  globalThis.MutationObserver = _mo; (globalThis as any).DOMParser = _dp;
});
function setup() {
  const win = new Window();
  (win as any).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win; // @ts-expect-error
  globalThis.document = win.document; // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
  (globalThis as any).DOMParser = (win as any).DOMParser;
  // Build a store nav row: 2 shared-class tab buttons with a caret svg.
  const row = win.document.createElement('div'); row.id = 'row';
  for (const t of ['Просмотр', 'Категории']) { // strings-allow-cyrillic
    const b = win.document.createElement('button');
    b.setAttribute('aria-expanded', 'false'); b.className = 'tab';
    b.innerHTML = `<div>${t}<svg viewBox="0 0 12 12"><path d="M0 0"/></svg></div>`;
    row.appendChild(b);
  }
  win.document.body.appendChild(row);
  const registry = createRegistry();
  _reg = registry;
  return { row, registry, bridge: { call: async () => ({}) } as any };
}
const OPTS = {
  id: 'booster-catalog-nav', label: 'Каталог игр', // strings-allow-cyrillic
  url: 'https://steambalance.cc/booster/catalog', variant: 'brand' as const,
  icon: '<svg viewBox="0 0 14 12"><path fill="currentColor" d="M0 0"/></svg>',
};

test('inserts a brand button as the first child of the nav row', () => {
  const { row, registry, bridge } = setup();
  const ui = makeUiApi(registry, bridge);
  ui.addStoreNavButton(OPTS);
  const first = row.firstElementChild as HTMLElement;
  expect(first.id).toBe('booster-catalog-nav');
  expect(first.getAttribute('data-booster-variant')).toBe('brand');
  expect(first.querySelector('.booster-storenav-label')?.textContent).toBe('Каталог игр'); // strings-allow-cyrillic
  expect(first.querySelector('.booster-storenav-icon svg')).not.toBeNull();
});

test('re-inserts after a React-style wipe (MutationObserver)', async () => {
  const { row, registry, bridge } = setup();
  const ui = makeUiApi(registry, bridge);
  ui.addStoreNavButton(OPTS);
  document.getElementById('booster-catalog-nav')!.remove();
  await new Promise((r) => setTimeout(r, 20));    // let the observer fire
  expect(document.getElementById('booster-catalog-nav')).not.toBeNull();
});

test('mounts the instant the nav row appears LATER (no 800ms interval wait)', async () => {
  // Reproduces the real store: our code runs at document-start, BEFORE React
  // renders the nav row. The button must appear via a documentElement observer
  // the moment the row is added — not only on the slow reconcile interval
  // (which is what caused the visible ~500ms pop-in). Start with NO row.
  const win = new Window();
  (win as any).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win; // @ts-expect-error
  globalThis.document = win.document; // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
  (globalThis as any).DOMParser = (win as any).DOMParser;
  const registry = createRegistry();
  _reg = registry;
  const ui = makeUiApi(registry, { call: async () => ({}) } as any);
  ui.addStoreNavButton(OPTS);
  expect(document.getElementById('booster-catalog-nav')).toBeNull();  // no row yet

  // React renders the store nav row now.
  const row = win.document.createElement('div'); row.id = 'late-row';
  for (const t of ['a', 'b']) {
    const b = win.document.createElement('button');
    b.setAttribute('aria-expanded', 'false'); b.className = 'tab';
    b.innerHTML = `<div>${t}<svg viewBox="0 0 12 12"><path d="M0 0"/></svg></div>`;
    row.appendChild(b);
  }
  win.document.body.appendChild(row);

  // Only a short tick — far below STORENAV_RECONCILE_MS (800ms). The appearance
  // observer must have already inserted the button (microtask, before paint).
  await new Promise((r) => setTimeout(r, 30));
  const btn = document.getElementById('booster-catalog-nav');
  expect(btn).not.toBeNull();
  expect(btn!.parentElement?.id).toBe('late-row');
});

test('forced interval re-validation self-heals an initial mis-pick', async () => {
  // The observer's O(1) fast-path guard freezes the button in whatever row it
  // first landed in. If findStoreNav's pick later changes (a richer row renders
  // / tie-break flips), only the FORCED interval re-check must move it — the
  // guard must NOT permanently freeze a wrong pick for the page's lifetime.
  const win = new Window();
  (win as any).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win; // @ts-expect-error
  globalThis.document = win.document; // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
  (globalThis as any).DOMParser = (win as any).DOMParser;
  const mkRow = (id: string, cls: string, n: number): HTMLElement => {
    const row = win.document.createElement('div'); row.id = id;
    for (let i = 0; i < n; i++) {
      const b = win.document.createElement('button');
      b.setAttribute('aria-expanded', 'false'); b.className = cls;
      b.innerHTML = `<div>t<svg viewBox="0 0 12 12"><path d="M0 0"/></svg></div>`;
      row.appendChild(b);
    }
    return row;
  };
  win.document.body.appendChild(mkRow('rowA', 'a', 2));   // only candidate at mount
  const registry = createRegistry();
  _reg = registry;
  const ui = makeUiApi(registry, { call: async () => ({}) } as any);
  ui.addStoreNavButton(OPTS);
  expect(document.getElementById('booster-catalog-nav')!.parentElement?.id).toBe('rowA');

  // A richer row (3 tabs) renders → findStoreNav would now prefer it, but the
  // observer's guard keeps the button frozen in rowA.
  win.document.body.appendChild(mkRow('rowB', 'b', 3));
  await new Promise((r) => setTimeout(r, 60));   // observer fires; guard skips
  expect(document.getElementById('booster-catalog-nav')!.parentElement?.id).toBe('rowA');

  // Past one interval tick (STORENAV_RECONCILE_MS=800ms): forced re-validation
  // self-heals the pick and moves the button to the richer row.
  await new Promise((r) => setTimeout(r, 900));
  expect(document.getElementById('booster-catalog-nav')!.parentElement?.id).toBe('rowB');
});

test('handle.remove() + registry rollback both fully tear down', () => {
  const { registry, bridge } = setup();
  const ui = makeUiApi(registry, bridge);
  const h = ui.addStoreNavButton(OPTS);
  h.remove();
  expect(document.getElementById('booster-catalog-nav')).toBeNull();
  // rollback of a fresh handle must not throw / re-add
  const h2 = ui.addStoreNavButton({ ...OPTS, id: 'booster-catalog-nav-2' });
  registry.rollbackAll();
  expect(document.getElementById('booster-catalog-nav-2')).toBeNull();
  void h2;
});

test('click navigates via location.assign', () => {
  const { registry, bridge } = setup();
  const calls: string[] = [];
  (window.location as any).assign = (u: string) => { calls.push(u); };
  const ui = makeUiApi(registry, bridge);
  ui.addStoreNavButton(OPTS);
  (document.getElementById('booster-catalog-nav') as HTMLElement).click();
  expect(calls).toEqual(['https://steambalance.cc/booster/catalog']);
});

test('throws on invalid id and unsafe url', () => {
  const { registry, bridge } = setup();
  const ui = makeUiApi(registry, bridge);
  expect(() => ui.addStoreNavButton({ ...OPTS, id: 'bad id!' })).toThrow(/invalid id/);
  expect(() => ui.addStoreNavButton({ ...OPTS, url: 'http://x' })).toThrow(/url/);
});

test('throws on empty/oversized label and oversized icon (mirrors addMenuItem)', () => {
  const { registry, bridge } = setup();
  const ui = makeUiApi(registry, bridge);
  expect(() => ui.addStoreNavButton({ ...OPTS, label: '' })).toThrow(/label/);
  expect(() => ui.addStoreNavButton({ ...OPTS, label: 'x'.repeat(121) })).toThrow(/label/);
  expect(() => ui.addStoreNavButton({ ...OPTS, icon: '<svg>' + 'a'.repeat(16 * 1024) + '</svg>' })).toThrow(/icon/);
});
