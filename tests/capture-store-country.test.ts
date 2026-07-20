import { test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseStoreCountryName } from '../src/steam-internals/capture-store-country';

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
  delete (globalThis as Record<string, unknown>)['location'];
});

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('parses the English country name from the country_settings block', () => {
  expect(parseStoreCountryName(fx('account-en-kz.html'))).toBe('Kazakhstan');
});

test('parses the span regardless of locale (mapping is separate)', () => {
  expect(parseStoreCountryName(fx('account-ru-kz.html'))).toBe('Казахстан');
});

test('returns undefined when the country block is absent', () => {
  expect(parseStoreCountryName('<div class="other">no country here</div>')).toBeUndefined();
  expect(parseStoreCountryName('')).toBeUndefined();
});

test('does not match a different account_data_field that precedes country_settings', () => {
  const html = '<span class="account_data_field">+7 700 000</span>' +
    '<div class="country_settings"><span class="account_data_field">Kazakhstan</span></div>';
  expect(parseStoreCountryName(html)).toBe('Kazakhstan');
});

import { maybeCaptureStoreCountry } from '../src/steam-internals/capture-store-country';

function makeScope(html: string, ok = true) {
  return {
    fetch: async () => ({ ok, text: async () => html } as Response),
    setTimeout: (cb: () => void, ms: number) => globalThis.setTimeout(cb, ms),
    clearTimeout: (id: unknown) => globalThis.clearTimeout(id as never),
  } as never;
}
function setOrigin(origin: string) {
  // happy-dom not used here; stub location via globalThis.
  (globalThis as Record<string, unknown>)['location'] = { origin } as Location;
}

test('maybeCaptureStoreCountry sets country from a store context', async () => {
  setOrigin('https://store.steampowered.com');
  (globalThis as Record<string, unknown>)['g_AccountID'] = 1340000000;
  const calls: Array<{ op: string; args: unknown }> = [];
  const bridge = { call: async (op: string, args: unknown) => { calls.push({ op, args }); return {}; } } as never;
  maybeCaptureStoreCountry(bridge, makeScope('<div class="country_settings"><span class="account_data_field">Kazakhstan</span></div>'));
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toContainEqual({ op: 'set_store_country', args: { steamId: '76561199300265728', country: 'KZ' } });
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
});

test('no-op outside store origin', async () => {
  setOrigin('https://steamloopback.host');
  (globalThis as Record<string, unknown>)['g_AccountID'] = 1340000000;
  const calls: unknown[] = [];
  const bridge = { call: async (op: string) => { calls.push(op); return {}; } } as never;
  maybeCaptureStoreCountry(bridge, makeScope('<div class="country_settings"><span class="account_data_field">Kazakhstan</span></div>'));
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toEqual([]);
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
});

test('no-op when g_AccountID never appears (bounded wait, then give up)', async () => {
  setOrigin('https://store.steampowered.com');
  // Short interval too, so the give-up path (waited >= budget) actually runs
  // within the wait window — otherwise the assert fires before the first tick.
  process.env['SB_STORE_COUNTRY_POLL_INTERVAL_MS'] = '15';
  process.env['SB_STORE_COUNTRY_POLL_MAX_MS'] = '60';
  const calls: unknown[] = [];
  const bridge = { call: async (op: string) => { calls.push(op); return {}; } } as never;
  maybeCaptureStoreCountry(bridge, makeScope('<div class="country_settings"><span class="account_data_field">Kazakhstan</span></div>'));
  await new Promise((r) => setTimeout(r, 150));   // > budget, so poll has given up
  expect(calls).toEqual([]);
  delete process.env['SB_STORE_COUNTRY_POLL_INTERVAL_MS'];
  delete process.env['SB_STORE_COUNTRY_POLL_MAX_MS'];
});

// The store page sets g_AccountID from its OWN inline scripts, which run AFTER
// our doc-start injection. Reading it once and bailing (the old behavior) meant
// capture almost never fired on a navigation — the account-switch bug. Poll for
// it instead of giving up on the first miss.
test('waits for a g_AccountID that appears after injection (doc-start race)', async () => {
  setOrigin('https://store.steampowered.com');
  process.env['SB_STORE_COUNTRY_POLL_INTERVAL_MS'] = '15';
  const calls: Array<{ op: string; args: unknown }> = [];
  const bridge = { call: async (op: string, args: unknown) => { calls.push({ op, args }); return {}; } } as never;
  // g_AccountID absent at call time; the page sets it 30ms later.
  maybeCaptureStoreCountry(bridge, makeScope('<div class="country_settings"><span class="account_data_field">Kazakhstan</span></div>'));
  setTimeout(() => { (globalThis as Record<string, unknown>)['g_AccountID'] = 1340000000; }, 30);
  await new Promise((r) => setTimeout(r, 250));
  expect(calls).toContainEqual({ op: 'set_store_country', args: { steamId: '76561199300265728', country: 'KZ' } });
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
  delete process.env['SB_STORE_COUNTRY_POLL_INTERVAL_MS'];
});

test('never throws on fetch failure / unknown country', async () => {
  setOrigin('https://store.steampowered.com');
  (globalThis as Record<string, unknown>)['g_AccountID'] = 1340000000;
  const bridge = { call: async () => ({}) } as never;
  // unknown country name → no set
  const calls: string[] = [];
  const bridge2 = { call: async (op: string) => { calls.push(op); return {}; } } as never;
  expect(() => maybeCaptureStoreCountry(bridge2, makeScope('<div class="country_settings"><span class="account_data_field">Atlantis</span></div>'))).not.toThrow();
  // fetch not ok → no set
  expect(() => maybeCaptureStoreCountry(bridge, makeScope('x', false))).not.toThrow();
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toEqual([]);
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
});
