import { test, expect } from 'bun:test';
import { accountIdToSteamId64, readCurrentSteamId64FromStoreGlobal } from '../src/steam-internals/steam-id';

test('accountIdToSteamId64 applies the individual-account base', () => {
  // 76561197960265728 + 1340000000 = 76561199300265728
  expect(accountIdToSteamId64(1340000000)).toBe('76561199300265728');
  expect(accountIdToSteamId64('1340000000')).toBe('76561199300265728');
});

test('accountIdToSteamId64 rejects junk', () => {
  expect(accountIdToSteamId64(undefined)).toBeUndefined();
  expect(accountIdToSteamId64(0)).toBeUndefined();
  expect(accountIdToSteamId64('abc')).toBeUndefined();
  expect(accountIdToSteamId64(-5)).toBeUndefined();
});

test('readCurrentSteamId64FromStoreGlobal reads g_AccountID when present', () => {
  (globalThis as Record<string, unknown>)['g_AccountID'] = 1340000000;
  expect(readCurrentSteamId64FromStoreGlobal()).toBe('76561199300265728');
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
  expect(readCurrentSteamId64FromStoreGlobal()).toBeUndefined();
});
