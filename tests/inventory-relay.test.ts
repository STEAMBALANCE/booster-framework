import { test, expect } from 'bun:test';
import { handleGetInventory } from '../src/relay/inventory';

function fakeBc() {
  const posted: any[] = [];
  return { posted, bc: { postMessage: (m: any) => posted.push(m) } as any };
}

test('handleGetInventory posts inventory-ok with the fetched result', async () => {
  // No g_FriendsUIApp ⇒ machinery unavailable ⇒ partial:true, empty items.
  (globalThis as any).window = {};
  const { posted, bc } = fakeBc();
  await handleGetInventory({ kind: 'get-inventory', requestId: 8, options: { apps: [{ appid: 753, contextid: '6' }] } }, bc);
  expect(posted[0].kind).toBe('inventory-ok');
  expect(posted[0].requestId).toBe(8);
  expect(posted[0].result.partial).toBe(true);
  expect(posted[0].result.items).toEqual([]);
});
