import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { makeUiApi } from '../src/api/ui';
import { createRegistry, type Registry } from '../src/registry';
import { RELAY_CHANNEL } from '../src/relay/protocol';

let _w: unknown, _d: unknown, _mo: unknown, _dp: unknown;
// CRITICAL (mirrors store-nav-button.test.ts): capture the per-test registry so
// afterEach tears down every button. Each addSuperNavButton leaks a
// setInterval(reconcile, 800) reading the GLOBAL document; bun shares timers
// across files, so a leaked interval would fire in a LATER file after this
// file's afterEach restored globalThis.document → a spurious TypeError blamed
// on an unrelated test. rollbackAll() fires each teardown (clearInterval +
// observer.disconnect + listener-remove + button.remove).
let _reg: Registry | undefined;
const _channels: BroadcastChannel[] = [];
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => { _w = globalThis.window; _d = globalThis.document; _mo = globalThis.MutationObserver; _dp = (globalThis as any).DOMParser; });
afterEach(() => {
  try { _reg?.rollbackAll(); } catch { /* */ }
  _reg = undefined;
  for (const c of _channels.splice(0)) { try { c.close(); } catch { /* */ } }
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
  const registry = createRegistry();
  _reg = registry;
  return { registry, bridge: { call: async () => ({}) } as any };
}

// A supernav tab: <div><span>text</span></div> (leaf-ish, non-empty text).
function mkTab(txt: string): HTMLElement {
  const d = document.createElement('div');
  const s = document.createElement('span'); s.textContent = txt; d.appendChild(s);
  return d;
}
// Build a supernav row: 2 leading svg icons + 3 nav tabs + a <НИК> tab.
// `extraTail` adds a trailing tab so 'after-profile' vs 'end' are distinct.
function buildSupernav(persona: string, opts: { id?: string; extraTail?: boolean } = {}): HTMLElement {
  const row = document.createElement('div');
  if (opts.id) row.id = opts.id;
  row.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  row.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  for (const t of ['Store', 'Library', 'Community']) row.appendChild(mkTab(t));
  row.appendChild(mkTab(persona));
  if (opts.extraTail) row.appendChild(mkTab('Tail'));
  document.body.appendChild(row);
  return row;
}

function feedSnapshot(snap: { personaName?: string; accountName?: string }): void {
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  _channels.push(bc);
  bc.postMessage({ kind: 'user-snapshot', snapshot: snap });
}

const OPTS = { id: 'sb-rate', label: 'Rate', onClick: () => {} };

test('anchors after the <НИК> tab once a user-snapshot arrives (default after-profile)', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix', { extraTail: true });
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS });
  expect(document.getElementById('sb-rate')).toBeNull();   // no name yet → not anchored
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  const btn = document.getElementById('sb-rate')!;
  expect(btn).not.toBeNull();
  expect(btn.getAttribute('data-booster-variant')).toBe('brand');
  expect((btn.previousElementSibling?.textContent ?? '').trim()).toBe('Matrix');
});

test("placement 'end' appends as the last child of the row", async () => {
  const { registry, bridge } = setup();
  const row = buildSupernav('Matrix', { extraTail: true });
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS, placement: 'end' });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  expect(row.lastElementChild?.id).toBe('sb-rate');
});

test('matches on account name when persona differs', async () => {
  const { registry, bridge } = setup();
  buildSupernav('LoginName');
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'other-persona', accountName: 'LoginName' });
  await flush();
  expect(document.getElementById('sb-rate')).not.toBeNull();
});

// NOTE: happy-dom's MutationObserver only reliably fires its FIRST batch, and
// here the button anchors ASYNC (snapshot), spending that fire on the initial
// insert. So the deterministic self-heal path exercised below is the forced
// 800ms reconcile interval (SUPERNAV_RECONCILE_MS) — same mechanism, and same
// ~900ms wait store-nav-button.test.ts uses for its forced-interval test. In
// real CEF the observer also re-inserts instantly (no such quirk).
const RECONCILE_WAIT = () => new Promise((r) => setTimeout(r, 900));

test('self-heals after a React-style wipe (forced reconcile)', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  document.getElementById('sb-rate')!.remove();
  await RECONCILE_WAIT();
  expect(document.getElementById('sb-rate')).not.toBeNull();
  expect(document.querySelectorAll('#sb-rate').length).toBe(1);   // no duplicate
});

test('re-anchors into a wholesale-replaced supernav container (forced reconcile)', async () => {
  const { registry, bridge } = setup();
  const rowA = buildSupernav('Matrix', { id: 'rowA' });
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  expect(document.getElementById('sb-rate')!.parentElement?.id).toBe('rowA');
  // Steam rebuilds: drop the old container, render a fresh one with the same nick.
  rowA.remove();
  buildSupernav('Matrix', { id: 'rowB' });
  await RECONCILE_WAIT();
  expect(document.getElementById('sb-rate')!.parentElement?.id).toBe('rowB');
  expect(document.querySelectorAll('#sb-rate').length).toBe(1);
});

test('setLoading(true) shows spinner, disables, and blocks the click', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  let clicks = 0;
  const ui = makeUiApi(registry, bridge);
  const h = ui.addSuperNavButton({ ...OPTS, onClick: () => { clicks++; } });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  const btn = document.getElementById('sb-rate')!;
  h.setLoading(true);
  expect(btn.getAttribute('data-booster-loading')).toBe('true');
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  btn.click();
  expect(clicks).toBe(0);
  h.setLoading(false);
  expect(btn.hasAttribute('data-booster-loading')).toBe(false);
  expect(btn.hasAttribute('aria-disabled')).toBe(false);
  btn.click();
  expect(clicks).toBe(1);
});

test('setEnabled(false) blocks the click; setEnabled(true) restores it', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  let clicks = 0;
  const ui = makeUiApi(registry, bridge);
  const h = ui.addSuperNavButton({ ...OPTS, onClick: () => { clicks++; } });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  const btn = document.getElementById('sb-rate')!;
  h.setEnabled(false);
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  btn.click();
  expect(clicks).toBe(0);
  h.setEnabled(true);
  expect(btn.hasAttribute('aria-disabled')).toBe(false);
  btn.click();
  expect(clicks).toBe(1);
});

test('busy guard: a second click while onClick is pending is ignored', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  let calls = 0;
  let release!: () => void;
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS, onClick: () => { calls++; return new Promise<void>((r) => { release = r; }); } });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  const btn = document.getElementById('sb-rate')!;
  btn.click();
  expect(calls).toBe(1);
  btn.click();               // still pending → ignored
  expect(calls).toBe(1);
  release();
  await flush();             // finally → busy = false
  btn.click();
  expect(calls).toBe(2);
});

test('flashError sets data-booster-error synchronously; remove() clears the pending timer', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  const ui = makeUiApi(registry, bridge);
  const h = ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  const btn = document.getElementById('sb-rate')!;

  const realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
  let capturing = false; const created: unknown[] = []; const cleared: unknown[] = [];
  globalThis.setTimeout = ((cb: any, ms?: any, ...a: any[]) => { const id = realST(cb, ms, ...a); if (capturing) created.push(id); return id; }) as any;
  globalThis.clearTimeout = ((id: any) => { cleared.push(id); return realCT(id); }) as any;
  try {
    capturing = true;
    h.flashError();
    capturing = false;
    expect(btn.getAttribute('data-booster-error')).toBe('true');
    expect(created.length).toBe(1);          // exactly one flash timer armed
    h.remove();
    expect(cleared).toContain(created[0]);   // teardown cleared it (no dangling timer)
  } finally {
    globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
  }
});

test('setLabel updates text in place; getRect returns a DOMRect', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  const ui = makeUiApi(registry, bridge);
  const h = ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  const btn = document.getElementById('sb-rate')!;
  h.setLabel('Changed');
  expect(btn.querySelector('.booster-supernav-label')?.textContent).toBe('Changed');
  expect(h.getRect()).toBeDefined();
});

test('account switch: a second snapshot with a new name re-anchors into the new tab', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix', { id: 'rowA' });
  const ui = makeUiApi(registry, bridge);
  ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  expect(document.getElementById('sb-rate')!.parentElement?.id).toBe('rowA');
  buildSupernav('Other', { id: 'rowB' });
  feedSnapshot({ personaName: 'Other' });
  await flush();
  expect(document.getElementById('sb-rate')!.parentElement?.id).toBe('rowB');
  expect(document.querySelectorAll('#sb-rate').length).toBe(1);
});

test('handle.remove() tears down (button gone, no re-anchor after)', async () => {
  const { registry, bridge } = setup();
  buildSupernav('Matrix');
  const ui = makeUiApi(registry, bridge);
  const h = ui.addSuperNavButton({ ...OPTS });
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  expect(document.getElementById('sb-rate')).not.toBeNull();
  h.remove();
  expect(document.getElementById('sb-rate')).toBeNull();
  // a late snapshot must not re-anchor a removed button
  feedSnapshot({ personaName: 'Matrix' });
  await flush();
  expect(document.getElementById('sb-rate')).toBeNull();
});

test('throws synchronously on invalid id, empty/oversized label, and non-function onClick', () => {
  const { registry, bridge } = setup();
  const ui = makeUiApi(registry, bridge);
  expect(() => ui.addSuperNavButton({ ...OPTS, id: 'bad id!' })).toThrow(/invalid id/);
  expect(() => ui.addSuperNavButton({ ...OPTS, label: '' })).toThrow(/label/);
  expect(() => ui.addSuperNavButton({ ...OPTS, label: 'x'.repeat(121) })).toThrow(/label/);
  expect(() => ui.addSuperNavButton({ ...OPTS, onClick: undefined as any })).toThrow(/onClick/);
});
