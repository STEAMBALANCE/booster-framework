// Family View (parental controls) detection.
//
// Steam exposes state only through a REGISTRATION callback, not a getter:
//   SteamClient.Parental.RegisterForParentalSettingsChanges(cb) -> { unregister }
// Verified against the live client — the callback fires immediately with the
// current settings, e.g. { ever_enabled: false, locked: false, settings: {} }.
// `locked: true` means the library/inventory stores are gated behind a PIN, so
// a rate-account run would collect a confidently-wrong empty payload.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readParentalState } from '../src/steam-internals/parental';

// bun runs every test file in ONE process, so globalThis.window is shared.
// Restore whatever was there instead of deleting it — deleting breaks files
// that expect a window to exist (e.g. plugins-api.test.ts).
let savedWindow: unknown;
let hadWindow = false;
beforeEach(() => {
  hadWindow = 'window' in globalThis;
  savedWindow = (globalThis as any).window;
});
afterEach(() => {
  if (hadWindow) (globalThis as any).window = savedWindow;
  else delete (globalThis as any).window;
});

function fakeParental(impl: (cb: (s: unknown) => void) => unknown): void {
  (globalThis as any).window = {
    SteamClient: { Parental: { RegisterForParentalSettingsChanges: impl } },
  };
}

test('reads locked state from the immediate callback', async () => {
  fakeParental((cb) => { cb({ ever_enabled: true, locked: true, settings: {} }); return { unregister: () => {} }; });
  expect(await readParentalState(200)).toEqual({ everEnabled: true, locked: true });
});

test('reads the common unlocked state', async () => {
  fakeParental((cb) => { cb({ ever_enabled: false, locked: false, settings: {} }); return { unregister: () => {} }; });
  expect(await readParentalState(200)).toEqual({ everEnabled: false, locked: false });
});

test('unregisters the subscription once resolved', async () => {
  let unregistered = 0;
  fakeParental((cb) => { cb({ ever_enabled: false, locked: false }); return { unregister: () => { unregistered++; } }; });
  await readParentalState(200);
  expect(unregistered).toBe(1);
});

test('returns undefined when the callback never fires (bounded)', async () => {
  fakeParental(() => ({ unregister: () => {} }));
  const started = Date.now();
  expect(await readParentalState(80)).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(2000);
});

test('returns undefined when SteamClient.Parental is absent', async () => {
  (globalThis as any).window = {};
  expect(await readParentalState(80)).toBeUndefined();
});

test('returns undefined when registration throws', async () => {
  fakeParental(() => { throw new Error('nope'); });
  expect(await readParentalState(80)).toBeUndefined();
});

test('never rejects on a malformed settings object', async () => {
  fakeParental((cb) => { cb(null); return { unregister: () => {} }; });
  expect(await readParentalState(200)).toEqual({ everEnabled: false, locked: false });
});
