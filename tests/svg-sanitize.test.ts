import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { sanitizeIconSvg } from '../src/api/svg-sanitize';

let _w: unknown, _d: unknown, _dp: unknown;
beforeEach(() => { _w = globalThis.window; _d = globalThis.document; _dp = (globalThis as any).DOMParser; });
afterEach(() => {
  // @ts-expect-error
  globalThis.window = _w; // @ts-expect-error
  globalThis.document = _d; (globalThis as any).DOMParser = _dp;
});
function doc(): Document {
  const win = new Window();
  (win as any).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win; // @ts-expect-error
  globalThis.document = win.document;
  (globalThis as any).DOMParser = (win as any).DOMParser;
  return win.document as unknown as Document;
}

test('keeps allowlisted svg/path, strips script + on* + url()', () => {
  const d = doc();
  const el = sanitizeIconSvg(
    '<svg viewBox="0 0 14 12"><script>window.x=1</script>'
    + '<path onload="alert(1)" fill="url(#g)" d="M0 0"/></svg>', d);
  expect(el).not.toBeNull();
  expect(el!.querySelector('script')).toBeNull();
  const path = el!.querySelector('path');
  expect(path).not.toBeNull();
  expect(path!.getAttribute('onload')).toBeNull();
  expect(path!.getAttribute('fill')).toBeNull();   // url(...) value dropped
  expect(path!.getAttribute('d')).toBe('M0 0');
});

test('rejects non-svg root', () => {
  const d = doc();
  expect(sanitizeIconSvg('<div>x</div>', d)).toBeNull();
});
