import { test, expect } from 'bun:test';
import { handleGetAccountLevel } from '../src/relay/account-level';

function fakeBc() { const posted: any[] = []; return { posted, bc: { postMessage: (m: any) => posted.push(m) } as any }; }

test('handleGetAccountLevel posts undefined level when machinery unavailable', async () => {
  (globalThis as any).window = {}; // no g_FriendsUIApp / webpack / steamAjaxRequest
  const { posted, bc } = fakeBc();
  await handleGetAccountLevel({ kind: 'get-account-level', requestId: 3, accountId: 134080832 }, bc);
  expect(posted[0]).toEqual({ kind: 'account-level-ok', requestId: 3, level: undefined });
});
