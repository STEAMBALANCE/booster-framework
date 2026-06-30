import { test, expect } from 'bun:test';
import { accountIdToSteamId64, readCurrentSteamId64FromStoreGlobal, steamId64ToAccountId } from '../src/steam-internals/steam-id';

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

test('steamId64ToAccountId derives the 32-bit account id (BigInt, no precision loss)', () => {
  expect(steamId64ToAccountId('76561198094346560')).toBe(134080832);
});
test('steamId64ToAccountId is the inverse of accountIdToSteamId64', () => {
  expect(accountIdToSteamId64(134080832)).toBe('76561198094346560');
  expect(steamId64ToAccountId('76561198094346560')).toBe(134080832);
});
test('steamId64ToAccountId returns undefined for absent / unparseable / below-base input', () => {
  expect(steamId64ToAccountId(undefined)).toBeUndefined();
  expect(steamId64ToAccountId('not-a-number')).toBeUndefined();
  expect(steamId64ToAccountId('76561197960265728')).toBeUndefined(); // base itself → acc 0
  expect(steamId64ToAccountId('76561202255233024')).toBeUndefined(); // acc = 0x100000000, one past 32-bit max
});
