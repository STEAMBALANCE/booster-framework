import { describe, test, expect } from 'bun:test';
import { LL } from '../src/i18n';

describe('framework i18n', () => {
  test('exposes framework.window.close_aria_label with expected value', () => {
    expect(LL.framework.window.close_aria_label()).toBe('Закрыть');
  });

  test('framework subtree contains only framework + general namespaces (no injector keys leak)', () => {
    // typesafe-i18n's i18nObject returns a proxy-like wrapper, so direct
    // property access on missing namespaces yields a fallback function rather
    // than `undefined`. The presence check that actually reflects the
    // generated dict is `Object.keys` / `hasOwnProperty`.
    expect(Object.keys(LL).sort()).toEqual(['framework', 'general']);
    expect(Object.prototype.hasOwnProperty.call(LL, 'injector')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(LL, 'payload')).toBe(false);
  });
});
