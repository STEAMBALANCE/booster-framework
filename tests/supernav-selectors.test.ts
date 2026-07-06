import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { findSuperNav } from '../src/steam-internals/supernav-selectors';

let win: Window;
let savedDoc: any, savedMO: any, savedDP: any;
beforeEach(() => {
  win = new Window();
  (win as any).SyntaxError = SyntaxError;           // happy-dom selector parser needs this
  savedDoc = (globalThis as any).document; savedMO = (globalThis as any).MutationObserver; savedDP = (globalThis as any).DOMParser;
  (globalThis as any).document = win.document;
  (globalThis as any).MutationObserver = win.MutationObserver;
  (globalThis as any).DOMParser = win.DOMParser;
});
afterEach(() => {
  (globalThis as any).document = savedDoc; (globalThis as any).MutationObserver = savedMO; (globalThis as any).DOMParser = savedDP;
});

// Build a DOM: Row-1 menu bar (5 text tabs, no name), Row-1 avatar widget
// (name + balance suffix), Row-2 supernav (2 svg + 3 nav tabs + <НИК> tab).
function build(persona: string): void {
  document.body.innerHTML = '';
  const mk = (txt: string, cls = 'hashA') => { const d = document.createElement('div'); d.className = cls; const s = document.createElement('span'); s.textContent = txt; d.appendChild(s); return d; };

  const menubar = document.createElement('div');
  ['Steam', 'Вид', 'Друзья', 'Игры', 'Справка'].forEach((t) => menubar.appendChild(mk(t, 'menuTab'))); // strings-allow-cyrillic
  document.body.appendChild(menubar);

  const avatar = document.createElement('div');
  avatar.textContent = persona + ' 17 181,65₸';   // balance suffix → not an exact match
  document.body.appendChild(avatar);

  const supernav = document.createElement('div');
  supernav.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  supernav.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  ['Магазин', 'Библиотека', 'Сообщество'].forEach((t) => supernav.appendChild(mk(t))); // strings-allow-cyrillic
  const nick = mk(persona);
  supernav.appendChild(nick);
  document.body.appendChild(supernav);
  (globalThis as any).__nick = nick.firstElementChild; // the leaf span
  (globalThis as any).__supernav = supernav;
}

describe('findSuperNav', () => {
  beforeEach(() => build('Matrix'));

  it('selects the supernav container via persona match (not the 5-tab menu bar)', () => {
    const r = findSuperNav({ personaName: 'Matrix' });
    expect(r).not.toBeNull();
    expect(r!.container).toBe((globalThis as any).__supernav);
    // anchorTab is the direct child of the container that carries the name
    expect(Array.from(r!.container.children)).toContain(r!.anchorTab);
    expect((r!.anchorTab.textContent ?? '').trim()).toBe('Matrix');
  });

  it('matches on account name when persona differs', () => {
    build('LoginName');
    const r = findSuperNav({ personaName: 'ignored', accountName: 'LoginName' });
    expect(r).not.toBeNull();
    expect(r!.container).toBe((globalThis as any).__supernav);
  });

  it('returns null when neither name is known (no structural fallback)', () => {
    expect(findSuperNav({})).toBeNull();
    expect(findSuperNav({ personaName: '', accountName: '  ' })).toBeNull();
  });

  it('ignores the balance-suffixed avatar widget (exact equality)', () => {
    const r = findSuperNav({ personaName: 'Matrix' });
    expect(r!.container).toBe((globalThis as any).__supernav);
  });

  it('matches a name with emoji/special chars', () => {
    build('▲Ma✦trix');
    const r = findSuperNav({ personaName: '▲Ma✦trix' });
    expect(r).not.toBeNull();
    expect(r!.container).toBe((globalThis as any).__supernav);
  });
});
