import { test, expect } from 'bun:test';
import { fetchAccountLevelWithDeps } from '../src/steam-internals/account-level';

test('returns level from the CM GetGameBadgeLevels path', async () => {
  const deps = {
    cmLevel: async () => 10,
    miniprofileLevel: async () => { throw new Error('should not be called'); },
  };
  expect(await fetchAccountLevelWithDeps(134080832, deps)).toBe(10);
});

test('falls back to miniprofile when CM yields undefined', async () => {
  const deps = { cmLevel: async () => undefined, miniprofileLevel: async () => 42 };
  expect(await fetchAccountLevelWithDeps(134080832, deps)).toBe(42);
});

test('returns undefined when both paths fail', async () => {
  const deps = { cmLevel: async () => undefined, miniprofileLevel: async () => undefined };
  expect(await fetchAccountLevelWithDeps(134080832, deps)).toBeUndefined();
});
