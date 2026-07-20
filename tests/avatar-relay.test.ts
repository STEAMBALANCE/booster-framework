import { test, expect, afterEach } from 'bun:test';
import { handleGetAvatar } from '../src/relay/avatar';

function fakeBc() { const posted: any[] = []; return { posted, bc: { postMessage: (m: any) => posted.push(m) } as any }; }

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

test('rejects a malformed steamId without fetching → dataUrl undefined', async () => {
  let fetched = false;
  (globalThis as any).fetch = async () => { fetched = true; return { ok: true } as any; };
  const { posted, bc } = fakeBc();
  await handleGetAvatar({ kind: 'get-avatar', requestId: 7, steamId: '../../etc/passwd' }, bc);
  expect(fetched).toBe(false);
  expect(posted[0]).toEqual({ kind: 'avatar-ok', requestId: 7, dataUrl: undefined });
});

test('posts dataUrl undefined when the avatar file is missing (non-ok fetch)', async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 404 } as any);
  const { posted, bc } = fakeBc();
  await handleGetAvatar({ kind: 'get-avatar', requestId: 9, steamId: '76561198094346560' }, bc);
  expect(posted[0]).toEqual({ kind: 'avatar-ok', requestId: 9, dataUrl: undefined });
});

test('swallows a fetch throw and still posts avatar-ok (never rejects across relay)', async () => {
  (globalThis as any).fetch = async () => { throw new Error('boom'); };
  const { posted, bc } = fakeBc();
  await handleGetAvatar({ kind: 'get-avatar', requestId: 11, steamId: '76561198094346560' }, bc);
  expect(posted[0]).toEqual({ kind: 'avatar-ok', requestId: 11, dataUrl: undefined });
});
