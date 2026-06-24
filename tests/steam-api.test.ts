import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { RELAY_CHANNEL } from '../src/relay/protocol';
import { isUrlSafeForNavigation, makeSteamApi } from '../src/api/steam';
import { createRegistry } from '../src/registry';

// Minimal bridge stub — steam-api tests exercise BC-based methods (openUrl,
// getCurrentUser, onUserChange) that don't touch the bridge.
const fakeBridge = { call: async () => ({}) } as never;

// The validator is URL-shape-only (no host allow-list) because the
// legitimate payment flow redirects through a runtime-discovered processor
// host (Tinkoff / СБП / etc.). Tests reflect: ANY https host is accepted
// as long as it's well-formed; foot-gun URL shapes are still rejected.

test('isUrlSafeForNavigation accepts plain https URL on any host', () => {
  expect(isUrlSafeForNavigation('https://steambalance.cc/x')).toBe(true);
  expect(isUrlSafeForNavigation('https://example-payment.processor.io/pay/abc')).toBe(true);
  expect(isUrlSafeForNavigation('https://тинькофф.ru/path?q=1')).toBe(true);
});

test('isUrlSafeForNavigation rejects http (non-https) scheme', () => {
  expect(isUrlSafeForNavigation('http://steambalance.cc/x')).toBe(false);
  expect(isUrlSafeForNavigation('ftp://example.com/x')).toBe(false);
});

test('isUrlSafeForNavigation rejects URL with userinfo (credential injection)', () => {
  expect(isUrlSafeForNavigation('https://attacker:pass@steambalance.cc/x')).toBe(false);
  expect(isUrlSafeForNavigation('https://user@steambalance.cc/x')).toBe(false);
  expect(isUrlSafeForNavigation('https://a:b@whatever.example.com/x')).toBe(false);
});

test('isUrlSafeForNavigation rejects URL with explicit non-default port', () => {
  expect(isUrlSafeForNavigation('https://steambalance.cc:8080/x')).toBe(false);
  expect(isUrlSafeForNavigation('https://anything.com:8443/x')).toBe(false);
});

test('isUrlSafeForNavigation rejects malformed URL', () => {
  expect(isUrlSafeForNavigation('not a url')).toBe(false);
  expect(isUrlSafeForNavigation('')).toBe(false);
  expect(isUrlSafeForNavigation('//steambalance.cc/x')).toBe(false);
});

test('openUrl rejection error mentions only hostname (no userinfo PII)', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);
  let captured: Error | null = null;
  try {
    await api.openUrl('https://attacker:secret@evil.example.com/path?token=abc');
  } catch (e) {
    captured = e as Error;
  }
  expect(captured).not.toBeNull();
  const msg = captured!.message;
  // Hostname surfaces in the diagnostic.
  expect(msg).toContain('evil.example.com');
  // PII fields from the URL must NOT appear — userinfo and query string
  // can carry session tokens and must stay out of logs.
  expect(msg).not.toContain('attacker');
  expect(msg).not.toContain('secret');
  expect(msg).not.toContain('token=abc');
});

// ── New tests for sync getCurrentUser + onUserChange + getCurrentUserAsync ──

test('getCurrentUser returns null before any user-snapshot BC', () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);
  expect(api.getCurrentUser()).toBeNull();
});

test('getCurrentUser returns SteamUser after user-snapshot BC arrives', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({
    kind: 'user-snapshot',
    snapshot: {
      accountName: 'matrix',
      personaName: 'Matrix',
      steamId: '76561198000000000',
      balanceFormatted: '2 177,35₸',
      isLimited: false,
      isOfflineMode: false,
    },
  });
  await new Promise((r) => setTimeout(r, 5));

  const u = api.getCurrentUser();
  expect(u?.accountName).toBe('matrix');
  expect(u?.personaName).toBe('Matrix');
  expect(u?.currency).toBe('KZT');
  expect(u?.balance).toBe(2177.35);
  expect(u?.balanceFormatted).toBe('2 177,35₸');
  fake.close();
});

test('onUserChange fires immediately if cache populated', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
  await new Promise((r) => setTimeout(r, 5));

  let called = 0;
  const off = api.onUserChange(() => { called++; });
  expect(called).toBe(1);
  off();
  fake.close();
});

test('onUserChange fires on each subsequent snapshot', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);

  const events: string[] = [];
  api.onUserChange((u) => events.push(u?.accountName ?? 'null'));

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'alice' } });
  await new Promise((r) => setTimeout(r, 5));
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'bob' } });
  await new Promise((r) => setTimeout(r, 5));

  expect(events).toEqual(['alice', 'bob']);
  fake.close();
});

test('getCurrentUserAsync resolves immediately if cache populated', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
  await new Promise((r) => setTimeout(r, 5));

  const u = await api.getCurrentUserAsync();
  expect(u.accountName).toBe('matrix');
  fake.close();
});

test('getCurrentUserAsync awaits first snapshot if cache empty', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);

  const promise = api.getCurrentUserAsync();
  // No snapshot yet — promise pending.

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });

  const u = await promise;
  expect(u.accountName).toBe('matrix');
  fake.close();
});

test('getCurrentUserAsync rejects with "framework rolled back" on registry rollback', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const registry = createRegistry();
  const api = makeSteamApi(registry);

  // Start waiting — no snapshot arrives.
  const promise = api.getCurrentUserAsync();

  // Simulate framework rollback.
  registry.rollbackAll();

  await expect(promise).rejects.toThrow('framework rolled back');
});

test('getCurrentUser posts request-snapshot at construction', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const fake = new BroadcastChannel(RELAY_CHANNEL);
  const received: unknown[] = [];
  fake.addEventListener('message', (ev) => received.push(ev.data));

  makeSteamApi(createRegistry());
  await new Promise((r) => setTimeout(r, 5));

  expect(received).toContainEqual({ kind: 'request-snapshot' });
  fake.close();
});

test('user.email() — each call posts BC; relay-side cache dedupes SteamClient', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const fake = new BroadcastChannel(RELAY_CHANNEL);

  // Stub relay: respond to get-user-account-settings with email.
  let calls = 0;
  fake.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { kind?: string; requestId?: number } | undefined;
    if (m?.kind !== 'get-user-account-settings') return;
    calls++;
    fake.postMessage({
      kind: 'user-account-settings-ok',
      requestId: m.requestId,
      email: 'm@example.com',
      emailValidated: true,
    });
  });

  const api = makeSteamApi(createRegistry(), fakeBridge);

  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
  await new Promise((r) => setTimeout(r, 5));

  const u = api.getCurrentUser()!;
  const e1 = await u.email();
  const e2 = await u.email();
  expect(e1).toBe('m@example.com');
  expect(e2).toBe('m@example.com');
  // Each call goes to relay; relay-side cache deduplicates SteamClient
  // calls but framework still posts 2 BC messages. (Spec note: «cache hit»
  // refers to avoided SteamClient call — not sync resolve.)
  expect(calls).toBe(2);
  fake.close();
});

test('user.email() and user.emailValidated() called concurrently → single BC roundtrip', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const fake = new BroadcastChannel(RELAY_CHANNEL);

  let calls = 0;
  fake.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { kind?: string; requestId?: number } | undefined;
    if (m?.kind !== 'get-user-account-settings') return;
    calls++;
    fake.postMessage({
      kind: 'user-account-settings-ok',
      requestId: m.requestId,
      email: 'm@example.com',
      emailValidated: true,
    });
  });

  const api = makeSteamApi(createRegistry(), fakeBridge);

  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
  await new Promise((r) => setTimeout(r, 5));

  const u = api.getCurrentUser()!;
  // Concurrent — both should share the inflight Promise and result in 1 BC roundtrip.
  const [e, v] = await Promise.all([u.email(), u.emailValidated()]);
  expect(e).toBe('m@example.com');
  expect(v).toBe(true);
  expect(calls).toBe(1);
  fake.close();
});

test('user.email() resolves to undefined on relay timeout', async () => {
  process.env['SB_USER_EXTRA_RELAY_TIMEOUT_MS'] = '50';
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const fake = new BroadcastChannel(RELAY_CHANNEL);
  // Don't respond to get-user-account-settings — let it time out.

  const api = makeSteamApi(createRegistry(), fakeBridge);

  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
  await new Promise((r) => setTimeout(r, 5));

  const u = api.getCurrentUser()!;
  const e = await u.email();
  expect(e).toBeUndefined();
  fake.close();
  delete process.env['SB_USER_EXTRA_RELAY_TIMEOUT_MS'];
});

test('user.email() never rejects (resolves undefined on bridge fail)', async () => {
  // Even with no relay listener, never throws.
  process.env['SB_USER_EXTRA_RELAY_TIMEOUT_MS'] = '50';
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const api = makeSteamApi(createRegistry(), fakeBridge);

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
  await new Promise((r) => setTimeout(r, 5));

  const u = api.getCurrentUser()!;
  await expect(u.email()).resolves.toBeUndefined();
  fake.close();
  delete process.env['SB_USER_EXTRA_RELAY_TIMEOUT_MS'];
});

import { accountIdToSteamId64 } from '../src/steam-internals/steam-id';

test('getStoreCountry returns the country for the current steamId', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  let askedSteamId: string | undefined;
  const bridge = { call: async (_op: string, args: { steamId: string }) => {
    askedSteamId = args.steamId;
    return { country: 'KZ' };
  } } as never;
  const api = makeSteamApi(createRegistry(), bridge);

  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'm', steamId: '76561199300265728' } });
  await new Promise((r) => setTimeout(r, 5));

  expect(await api.getStoreCountry()).toBe('KZ');
  expect(askedSteamId).toBe('76561199300265728');
  fake.close();
});

test('getStoreCountry returns undefined when C++ has null', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const bridge = { call: async () => ({ country: null }) } as never;
  const api = makeSteamApi(createRegistry(), bridge);
  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'm', steamId: '76561199300265728' } });
  await new Promise((r) => setTimeout(r, 5));
  expect(await api.getStoreCountry()).toBeUndefined();
  fake.close();
});

test('getStoreCountry never rejects on bridge failure', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const bridge = { call: async () => { throw new Error('bridge down'); } } as never;
  const api = makeSteamApi(createRegistry(), bridge);
  const fake = new BroadcastChannel(RELAY_CHANNEL);
  fake.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'm', steamId: '76561199300265728' } });
  await new Promise((r) => setTimeout(r, 5));
  await expect(api.getStoreCountry()).resolves.toBeUndefined();
  fake.close();
});

test('getStoreCountry uses store-page g_AccountID when no snapshot (Web context)', async () => {
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  (globalThis as Record<string, unknown>)['g_AccountID'] = 1340000000;
  let askedSteamId: string | undefined;
  const bridge = { call: async (_op: string, args: { steamId: string }) => {
    askedSteamId = args.steamId; return { country: 'KZ' };
  } } as never;
  const api = makeSteamApi(createRegistry(), bridge);  // no snapshot posted
  expect(await api.getStoreCountry()).toBe('KZ');
  expect(askedSteamId).toBe(accountIdToSteamId64(1340000000));
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
});

test('getStoreCountry resolves undefined (never rejects) if rolled back mid steamId-wait', async () => {
  process.env['SB_STORE_COUNTRY_STEAMID_WAIT_MS'] = '50';
  delete (globalThis as Record<string, unknown>)['g_AccountID'];
  const win = new Window();
  // @ts-expect-error
  globalThis.window = win;
  const registry = createRegistry();
  const bridge = { call: async () => ({ country: 'KZ' }) } as never;
  const api = makeSteamApi(registry, bridge);  // no snapshot, no g_AccountID → enters bounded wait
  const p = api.getStoreCountry();
  registry.rollbackAll();                        // clears userChangeListeners mid-wait
  await expect(p).resolves.toBeUndefined();      // resolves on timeout, no unhandled rejection
  delete process.env['SB_STORE_COUNTRY_STEAMID_WAIT_MS'];
});
