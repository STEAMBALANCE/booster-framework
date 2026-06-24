// framework/tests/relay-user-data.test.ts
import { test, expect, beforeEach, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { RELAY_CHANNEL } from '../src/relay/protocol';
import { createScope } from '../src/api/scope';

// Module under test imported lazily after window setup:
async function loadModule() {
  return await import('../src/relay/user-data');
}

interface FakeUserChange {
  strAccountName?: string;
  strSteamID?: string;
  strAccountBalance?: string;
  bIsLimited?: boolean;
  bIsOfflineMode?: boolean;
  NotificationCounts?: Record<string, number>;
}

function setupWindowWithSteamClient(opts: {
  personaName?: string;
} = {}) {
  const win = new Window();
  // @ts-expect-error - happy-dom assigned to globalThis.window
  globalThis.window = win;

  const callbacks: Array<(info: FakeUserChange) => void> = [];
  const fakeUser = {
    GetLoginUsers: mock(async () => [{ accountName: 'matrix' }]),
    GetIPCountry:  mock(async () => 'KZ'),
    RegisterForCurrentUserChanges: mock((cb: (info: FakeUserChange) => void) => {
      callbacks.push(cb);
      return { unregister: () => {} };
    }),
  };
  const fakeSettings = {
    GetAccountSettings: mock(async () => ({ strEmail: 'm@example.com', bEmailValidated: true })),
    GetCurrentLanguage: mock(async () => 'russian'),
  };
  (win as unknown as { SteamClient: unknown }).SteamClient = { User: fakeUser, Settings: fakeSettings };
  if (opts.personaName !== undefined) {
    (win as unknown as { App: unknown }).App = { m_cm: { m_strPersonaName: opts.personaName } };
  }
  return { win, callbacks, fakeUser, fakeSettings };
}

beforeEach(async () => {
  // Clean global window before each test to avoid leaks
  // @ts-expect-error
  delete globalThis.window;
  // Reset module-level state between tests (the module gets cached by bun):
  try {
    const mod = await import('../src/relay/user-data');
    (mod as { __resetForTests?: () => void }).__resetForTests?.();
  } catch { /* module may not exist yet during first red run */ }
});

test('first user-change callback broadcasts user-snapshot', async () => {
  const { callbacks } = setupWindowWithSteamClient({ personaName: 'Matrix' });
  const scope = createScope();
  // bc is the sender passed to installUserChangeListener.
  // receiver is a separate BroadcastChannel instance on the same channel —
  // per the BroadcastChannel spec, a sender does not receive its own messages,
  // so we need a distinct listener instance.
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);

  // simulate Steam firing the callback
  callbacks[0]!({
    strAccountName: 'matrix',
    strSteamID: '76561198000000000',
    strAccountBalance: '2 177,35₸',
    bIsLimited: false,
    bIsOfflineMode: false,
  });

  // Allow microtasks
  await new Promise((r) => setTimeout(r, 5));

  expect(received).toEqual([
    {
      kind: 'user-snapshot',
      snapshot: {
        accountName: 'matrix',
        personaName: 'Matrix',
        steamId: '76561198000000000',
        balanceFormatted: '2 177,35₸',
        isLimited: false,
        isOfflineMode: false,
      },
    },
  ]);
  receiver.close();
  bc.close();
  scope._abort();
});

test('NotificationCounts-only change → no broadcast', async () => {
  const { callbacks } = setupWindowWithSteamClient({ personaName: 'Matrix' });
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);

  callbacks[0]!({
    strAccountName: 'matrix', strSteamID: '76561198000000000',
    strAccountBalance: '2 177,35₸', bIsLimited: false, bIsOfflineMode: false,
    NotificationCounts: { messages: 1 },
  });
  callbacks[0]!({
    strAccountName: 'matrix', strSteamID: '76561198000000000',
    strAccountBalance: '2 177,35₸', bIsLimited: false, bIsOfflineMode: false,
    NotificationCounts: { messages: 2 },     // only this changed
  });

  await new Promise((r) => setTimeout(r, 5));
  expect(received).toHaveLength(1);   // only first broadcast, second suppressed
  receiver.close();
  bc.close();
  scope._abort();
});

test('personaName change (CM populates late) → broadcast', async () => {
  // First setup with empty persona; later we mutate the global.
  const { callbacks } = setupWindowWithSteamClient({ personaName: '' });
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);

  const baseSnap = {
    strAccountName: 'matrix', strSteamID: '76561198000000000',
    strAccountBalance: '2 177,35₸', bIsLimited: false, bIsOfflineMode: false,
  };
  callbacks[0]!(baseSnap);   // first — personaName undefined → broadcast
  // Now CM populates persona. Mutate global before second callback.
  ((globalThis.window as unknown as { App: { m_cm: { m_strPersonaName: string } } }).App.m_cm.m_strPersonaName) = 'Matrix';
  callbacks[0]!(baseSnap);   // same snapshot, but persona differs → broadcast

  await new Promise((r) => setTimeout(r, 5));
  expect(received).toHaveLength(2);
  expect((received[1] as { snapshot: { personaName: string } }).snapshot.personaName).toBe('Matrix');
  receiver.close();
  bc.close();
  scope._abort();
});

test('handleRequestSnapshot before any callback — silent, no broadcast', async () => {
  setupWindowWithSteamClient({ personaName: 'Matrix' });
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  mod.handleRequestSnapshot(bc);

  await new Promise((r) => setTimeout(r, 5));
  expect(received).toHaveLength(0);   // silent
  receiver.close();
  bc.close();
  scope._abort();
});

test('handleRequestSnapshot after a callback — re-broadcasts current snapshot', async () => {
  const { callbacks } = setupWindowWithSteamClient({ personaName: 'Matrix' });
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);

  callbacks[0]!({
    strAccountName: 'matrix', strSteamID: '76561198000000000',
    strAccountBalance: '2 177,35₸', bIsLimited: false, bIsOfflineMode: false,
  });
  await new Promise((r) => setTimeout(r, 5));
  // First broadcast received. Now request-snapshot — re-broadcast same.
  mod.handleRequestSnapshot(bc);
  await new Promise((r) => setTimeout(r, 5));

  expect(received).toHaveLength(2);
  expect(received[1]).toEqual(received[0]);   // identical re-broadcast
  receiver.close();
  bc.close();
  scope._abort();
});

test('handleGetUserAccountSettings cache miss → calls Settings.GetAccountSettings, broadcasts result', async () => {
  const { callbacks, fakeSettings } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  // Need a snapshot so accountName is set:
  callbacks[0]!({ strAccountName: 'matrix', strSteamID: '...' });
  await new Promise((r) => setTimeout(r, 5));

  await mod.handleGetUserAccountSettings({ kind: 'get-user-account-settings', requestId: 1 }, bc);
  await new Promise((r) => setTimeout(r, 0));

  // Drop the user-snapshot from received, look at user-account-settings-ok
  const ok = received.find((m) => (m as { kind?: string } | undefined)?.kind === 'user-account-settings-ok');
  expect(ok).toEqual({
    kind: 'user-account-settings-ok',
    requestId: 1,
    email: 'm@example.com',
    emailValidated: true,
  });
  expect(fakeSettings.GetAccountSettings).toHaveBeenCalledTimes(1);

  receiver.close();
  bc.close();
  scope._abort();
});

test('handleGetUserAccountSettings cache hit on second call', async () => {
  const { callbacks, fakeSettings } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  callbacks[0]!({ strAccountName: 'matrix', strSteamID: '...' });
  await new Promise((r) => setTimeout(r, 5));

  await mod.handleGetUserAccountSettings({ kind: 'get-user-account-settings', requestId: 1 }, bc);
  await mod.handleGetUserAccountSettings({ kind: 'get-user-account-settings', requestId: 2 }, bc);
  expect(fakeSettings.GetAccountSettings).toHaveBeenCalledTimes(1);   // cache hit on second
  bc.close(); scope._abort();
});

test('handleGetUserAccountSettings — accountName change mid-fetch returns undefined and skips cache write', async () => {
  const { callbacks, fakeSettings } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));
  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);

  // Slow GetAccountSettings — give time to switch accounts mid-flight.
  let resolveSettings!: (v: { strEmail?: string; bEmailValidated?: boolean } | undefined) => void;
  fakeSettings.GetAccountSettings.mockImplementation(
    // Cast needed: mock infers return type from the initial mock value; the
    // Promise<T | undefined> shape is wider but compatible at runtime.
    () => new Promise<{ strEmail?: string; bEmailValidated?: boolean } | undefined>(
      (res) => { resolveSettings = res; },
    ) as unknown as Promise<{ strEmail: string; bEmailValidated: boolean }>,
  );

  callbacks[0]!({ strAccountName: 'alice', strSteamID: '1' });
  await new Promise((r) => setTimeout(r, 5));

  const handlerPromise = mod.handleGetUserAccountSettings({ kind: 'get-user-account-settings', requestId: 1 }, bc);
  // mid-flight: switch account
  callbacks[0]!({ strAccountName: 'bob', strSteamID: '2' });
  await new Promise((r) => setTimeout(r, 5));
  // Now resolve original fetch with alice's data
  resolveSettings!({ strEmail: 'alice@x.com', bEmailValidated: true });
  await handlerPromise;
  await new Promise((r) => setTimeout(r, 0));

  const ok = received.find((m) => (m as { kind?: string } | undefined)?.kind === 'user-account-settings-ok');
  // Result returned to caller as undefined (alice's data is stale for bob)
  expect(ok).toEqual({
    kind: 'user-account-settings-ok',
    requestId: 1,
    email: undefined,
    emailValidated: undefined,
  });
  // Verify cache wasn't poisoned by alice's stale write — next call re-fetches.
  fakeSettings.GetAccountSettings.mockClear();
  fakeSettings.GetAccountSettings.mockResolvedValue({ strEmail: 'bob@x.com', bEmailValidated: false });
  await mod.handleGetUserAccountSettings({ kind: 'get-user-account-settings', requestId: 2 }, bc);
  await new Promise((r) => setTimeout(r, 0));
  expect(fakeSettings.GetAccountSettings).toHaveBeenCalledTimes(1);  // re-fetched, didn't read alice's stale cache
  receiver.close();
  bc.close(); scope._abort();
});

test('handleGetUserCountry cache miss → calls User.GetIPCountry, broadcasts result', async () => {
  const { callbacks, fakeUser } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  callbacks[0]!({ strAccountName: 'matrix', strSteamID: '...' });
  await new Promise((r) => setTimeout(r, 5));

  await mod.handleGetUserCountry({ kind: 'get-user-country', requestId: 1 }, bc);
  await new Promise((r) => setTimeout(r, 0));

  const ok = received.find((m) => (m as { kind?: string } | undefined)?.kind === 'user-country-ok');
  expect(ok).toEqual({ kind: 'user-country-ok', requestId: 1, value: 'KZ' });
  expect(fakeUser.GetIPCountry).toHaveBeenCalledTimes(1);
  receiver.close(); bc.close(); scope._abort();
});

test('handleGetUserCountry cache hit on second call', async () => {
  const { callbacks, fakeUser } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  callbacks[0]!({ strAccountName: 'matrix', strSteamID: '...' });
  await new Promise((r) => setTimeout(r, 5));

  await mod.handleGetUserCountry({ kind: 'get-user-country', requestId: 1 }, bc);
  await mod.handleGetUserCountry({ kind: 'get-user-country', requestId: 2 }, bc);
  expect(fakeUser.GetIPCountry).toHaveBeenCalledTimes(1);
  bc.close(); scope._abort();
});

test('handleGetUserLanguage cache miss → calls Settings.GetCurrentLanguage, broadcasts result', async () => {
  const { callbacks, fakeSettings } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const receiver = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  receiver.addEventListener('message', (ev) => received.push(ev.data));

  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  callbacks[0]!({ strAccountName: 'matrix', strSteamID: '...' });
  await new Promise((r) => setTimeout(r, 5));

  await mod.handleGetUserLanguage({ kind: 'get-user-language', requestId: 1 }, bc);
  await new Promise((r) => setTimeout(r, 0));

  const ok = received.find((m) => (m as { kind?: string } | undefined)?.kind === 'user-language-ok');
  expect(ok).toEqual({ kind: 'user-language-ok', requestId: 1, value: 'russian' });
  expect(fakeSettings.GetCurrentLanguage).toHaveBeenCalledTimes(1);
  receiver.close(); bc.close(); scope._abort();
});

test('handleGetUserLanguage cache hit on second call', async () => {
  const { callbacks, fakeSettings } = setupWindowWithSteamClient();
  const scope = createScope();
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const mod = await loadModule();
  mod.installUserChangeListener(scope, bc);
  callbacks[0]!({ strAccountName: 'matrix', strSteamID: '...' });
  await new Promise((r) => setTimeout(r, 5));

  await mod.handleGetUserLanguage({ kind: 'get-user-language', requestId: 1 }, bc);
  await mod.handleGetUserLanguage({ kind: 'get-user-language', requestId: 2 }, bc);
  expect(fakeSettings.GetCurrentLanguage).toHaveBeenCalledTimes(1);
  bc.close(); scope._abort();
});
