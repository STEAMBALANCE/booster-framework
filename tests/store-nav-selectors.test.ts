import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { findStoreNav } from '../src/steam-internals/store-nav-selectors';

let _w: unknown, _d: unknown;
beforeEach(() => { _w = globalThis.window; _d = globalThis.document; });
afterEach(() => {
  // @ts-expect-error
  globalThis.window = _w; // @ts-expect-error
  globalThis.document = _d;
});
function setup(): Document {
  const win = new Window();
  (win as any).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win; // @ts-expect-error
  globalThis.document = win.document;
  return win.document as unknown as Document;
}
// Build a tab button: <button aria-expanded><div>label<svg/></div></button>.
function tab(d: Document, cls: string, label: string): HTMLButtonElement {
  const b = d.createElement('button');
  b.setAttribute('aria-expanded', 'false');
  b.className = cls;
  b.innerHTML = `<div>${label}<svg viewBox="0 0 12 12"><path d="M0 0"/></svg></div>`;
  return b;
}

test('picks the parent holding the most shared-class tab buttons', () => {
  const d = setup();
  // Decoy group: a single aria-expanded+svg control (account pulldown).
  const decoy = d.createElement('div');
  decoy.appendChild(tab(d, 'acct-x', 'Account'));
  d.body.appendChild(decoy);
  // The real tab strip: 3 buttons sharing one class.
  const row = d.createElement('div');
  row.id = 'the-row';
  row.appendChild(tab(d, 'tab-hash', 'Просмотр'));       // strings-allow-cyrillic
  row.appendChild(tab(d, 'tab-hash', 'Рекомендации'));   // strings-allow-cyrillic
  row.appendChild(tab(d, 'tab-hash', 'Категории'));      // strings-allow-cyrillic
  d.body.appendChild(row);
  expect(findStoreNav()?.id).toBe('the-row');
});

test('tie on count → prefers the shared-className group', () => {
  const d = setup();
  const mixed = d.createElement('div'); mixed.id = 'mixed';
  mixed.appendChild(tab(d, 'a', 'x')); mixed.appendChild(tab(d, 'b', 'y'));
  d.body.appendChild(mixed);
  const shared = d.createElement('div'); shared.id = 'shared';
  shared.appendChild(tab(d, 'z', 'x')); shared.appendChild(tab(d, 'z', 'y'));
  d.body.appendChild(shared);
  expect(findStoreNav()?.id).toBe('shared');
});

test('returns null when no candidate group exists', () => {
  const d = setup();
  const solo = d.createElement('div');
  solo.appendChild(tab(d, 'a', 'x'));   // only 1 tab child
  d.body.appendChild(solo);
  expect(findStoreNav()).toBeNull();
});
