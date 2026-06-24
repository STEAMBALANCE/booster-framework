import { describe, expect, test } from 'bun:test';
import { canonicalUrl } from '../src/relay/url-helpers';
import { redactUrl } from '../src/relay/url-helpers';
import { redactErr, redactErrPure, stripUrlsForTest } from '../src/relay/url-helpers';

describe('canonicalUrl', () => {
  test('lowercases scheme and host', () => {
    expect(canonicalUrl('HTTPS://Example.com/path')).toBe('https://example.com/path');
  });
  test('drops default :443 port', () => {
    expect(canonicalUrl('https://example.com:443/foo')).toBe('https://example.com/foo');
  });
  test('appends trailing slash to empty path', () => {
    expect(canonicalUrl('https://example.com')).toBe('https://example.com/');
  });
  test('preserves query as-is', () => {
    expect(canonicalUrl('https://example.com/p?a=1&b=2')).toBe('https://example.com/p?a=1&b=2');
  });
  test('preserves fragment as-is', () => {
    expect(canonicalUrl('https://example.com/p#frag')).toBe('https://example.com/p#frag');
  });
  test('throws on invalid url', () => {
    expect(() => canonicalUrl('not-a-url')).toThrow();
  });
});

describe('redactUrl', () => {
  test('strips query and fragment', () => {
    expect(redactUrl('https://x.com/p?token=secret#frag')).toBe('https://x.com/p');
  });
  test('keeps scheme + host + path', () => {
    expect(redactUrl('https://example.com:443/api/v1?a=b')).toBe('https://example.com/api/v1');
  });
  test('handles malformed URL gracefully', () => {
    expect(redactUrl('not-a-url')).toBe('<malformed-url>');
  });
});

describe('redactErr', () => {
  // __SB_PRODUCTION__ is a build-time define. Tests run в dev (false).
  // The dev branch is the identity passthrough exercised here; the
  // production branch performs URL/query-string redaction and is
  // exercised end-to-end via the production bundle (no unit coverage —
  // bun's define replacement happens at build time, not runtime).

  test('passes Error through unchanged in dev', () => {
    const err = new Error('https://x.com/p?token=abc failed');
    expect(redactErr(err)).toBe(err);  // identity in dev
  });

  test('passes string unchanged in dev', () => {
    expect(redactErr('hello https://x.com/p?t=1')).toBe('hello https://x.com/p?t=1');
  });

  test('passes non-error/non-string through (number, object)', () => {
    expect(redactErr(42)).toBe(42);
    const o = { foo: 'bar' };
    expect(redactErr(o)).toBe(o);
  });
});

describe('redactErrPure (covers production path explicitly)', () => {
  // The pure helper takes `prod: boolean` so tests can drive both
  // branches without flipping the build-time __SB_PRODUCTION__ define.
  // Mirrors the same gating pattern logUserDataDev uses.

  test('prod=true: Error → new Error with URL query stripped', () => {
    const err = new Error('failed at https://x.com/p?token=secret with code 500');
    const out = redactErrPure(err, true);
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBe(err);  // new Error, not the same instance
    expect((out as Error).message).toBe('failed at https://x.com/p with code 500');
  });

  test('prod=false: Error → identity (same instance, unchanged)', () => {
    const err = new Error('failed at https://x.com/p?token=secret with code 500');
    expect(redactErrPure(err, false)).toBe(err);
  });

  test('prod=true: string → URL query stripped (and URL normalised by parse-then-redact)', () => {
    // redactUrl reparses each match — `https://x?token=abc` round-trips to
    // `https://x/` (WHATWG appends '/' to empty path, drops query).
    expect(redactErrPure('text https://x?token=abc', true))
      .toBe('text https://x/');
  });

  test('prod=false: string → unchanged', () => {
    expect(redactErrPure('hello https://x.com/p?t=1', false))
      .toBe('hello https://x.com/p?t=1');
  });

  test('prod=true: number → unchanged (non-Error/non-string passthrough)', () => {
    expect(redactErrPure(42, true)).toBe(42);
  });

  test('prod=true: object → unchanged (non-Error/non-string passthrough)', () => {
    const o = { foo: 'bar' };
    expect(redactErrPure(o, true)).toBe(o);
  });
});

describe('stripUrlsForTest (prod-mode equivalent of redactErr core)', () => {
  test('replaces URL substrings with redacted form', () => {
    expect(stripUrlsForTest('failed at https://x.com/p?token=secret with code 500'))
      .toBe('failed at https://x.com/p with code 500');
  });
  test('handles multiple URLs in one string', () => {
    expect(stripUrlsForTest('https://a/p?q=1 then https://b/r#f'))
      .toBe('https://a/p then https://b/r');
  });
  test('leaves text without URLs unchanged', () => {
    expect(stripUrlsForTest('no urls here')).toBe('no urls here');
  });
});
