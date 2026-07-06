import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { ensureSuperNavStyles } from '../src/api/ui-supernav-styles';

let savedDoc: any;
beforeEach(() => {
  const win = new Window();
  (win as any).SyntaxError = SyntaxError;   // happy-dom selector parser needs this
  savedDoc = (globalThis as any).document;
  (globalThis as any).document = win.document;
});
afterEach(() => { (globalThis as any).document = savedDoc; });

describe('ensureSuperNavStyles', () => {
  it('injects exactly one style tag, idempotent', () => {
    ensureSuperNavStyles(); ensureSuperNavStyles();
    const tags = document.head.querySelectorAll('style[id^="__sb_supernav_styles_"]');
    expect(tags.length).toBe(1);
    expect(tags[0].textContent).toContain('data-booster-supernav-btn');
    expect(tags[0].textContent).toContain('#34a37b');
    expect(tags[0].textContent).toContain('booster-supernav-spin');
  });
});
