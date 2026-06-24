import { test, expect } from 'bun:test';
import { isOriginSafe, sanitizeEmbedOrigins } from '../src/relay/window-handlers';

test('isOriginSafe: exact https origin only', () => {
  expect(isOriginSafe('https://steambalance.cc')).toBe(true);
  expect(isOriginSafe('https://pay.steambalance.cc')).toBe(true);
  expect(isOriginSafe('https://steambalance.cc/x')).toBe(false);   // path
  expect(isOriginSafe('https://steambalance.cc:8443')).toBe(false); // non-default port
  expect(isOriginSafe('http://steambalance.cc')).toBe(false);       // not https
  expect(isOriginSafe('https://u:p@steambalance.cc')).toBe(false);  // userinfo
  expect(isOriginSafe('https://стим.рф')).toBe(false);              // non-ascii
});

test('sanitizeEmbedOrigins strips unsafe entries and non-strings', () => {
  expect(sanitizeEmbedOrigins(['https://a.cc', 'http://b.cc', 'https://c.cc/x', 42, null, 'https://d.cc']))
    .toEqual(['https://a.cc', 'https://d.cc']);
});

test('sanitizeEmbedOrigins returns [] for non-array', () => {
  expect(sanitizeEmbedOrigins(undefined)).toEqual([]);
  expect(sanitizeEmbedOrigins('https://a.cc')).toEqual([]);
});

test('sanitizeEmbedOrigins caps at 8 safe origins', () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://h${i}.cc`);
  expect(sanitizeEmbedOrigins(many)).toHaveLength(8);
});
