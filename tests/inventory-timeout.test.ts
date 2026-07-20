// The inventory relay call needs a budget of its own. One getInventory() walks
// 5 partitions sequentially, each paginating with get_descriptions, so the 5s
// shared budget expired mid-walk precisely on item-rich accounts — and the
// result, which does arrive later, was dropped by the fire-and-forget relay.
import { test, expect, afterEach } from 'bun:test';
import { getInventoryTimeoutMs } from '../src/api/steam';

afterEach(() => { delete process.env['SB_INVENTORY_RELAY_TIMEOUT_MS']; });

test('defaults well above the 5s shared relay budget', () => {
  expect(getInventoryTimeoutMs()).toBeGreaterThan(5000);
});

test('stays under the native 40s CDP deadline on host.getRateAccountData', () => {
  expect(getInventoryTimeoutMs()).toBeLessThan(40000);
});

test('is overridable via env for tests', () => {
  process.env['SB_INVENTORY_RELAY_TIMEOUT_MS'] = '1234';
  expect(getInventoryTimeoutMs()).toBe(1234);
});

test('ignores a garbage override', () => {
  process.env['SB_INVENTORY_RELAY_TIMEOUT_MS'] = 'nope';
  expect(getInventoryTimeoutMs()).toBe(25000);
});
