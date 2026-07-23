import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { reportUserBinding } from '../src/report-user-binding';

function fakeBridge() {
  const calls: Array<{ op: string; args: any }> = [];
  const bridge = {
    call: async (op: string, args?: any) => { calls.push({ op, args }); return {}; },
    notify: () => {},
  } as any;
  return { calls, bridge };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('reportUserBinding', () => {
  // Default: no confirm-poll, so existing tests don't leave dangling timers.
  beforeEach(() => {
    process.env['SB_USER_BINDING_CONFIRM_ATTEMPTS'] = '0';
  });
  afterEach(() => {
    delete process.env['SB_USER_BINDING_CONFIRM_ATTEMPTS'];
    delete process.env['SB_USER_BINDING_CONFIRM_INTERVAL_MS'];
  });

  test('logs login, store country and currency when they resolve', async () => {
    const { calls, bridge } = fakeBridge();
    const steam = {
      getCurrentUserAsync: async () => ({ accountName: 'matrix_aas', currency: 'KZT' }),
      getStoreCountry: async () => 'KZ',
    } as any;
    reportUserBinding(steam, bridge);
    await tick();
    const log = calls.find((c) => c.op === 'logUserData');
    expect(log).toBeDefined();
    // country + currency are diagnostic (did region/currency detection work?),
    // not identity — no email/steamId/balance.
    expect(log!.args).toEqual({ login: 'matrix_aas', country: 'KZ', currency: 'KZT' });
  });

  test('sends null for country/currency that could not be determined', async () => {
    const { calls, bridge } = fakeBridge();
    const steam = {
      getCurrentUserAsync: async () => ({ accountName: 'u' }),        // no currency parsed
      getStoreCountry: async () => undefined,                         // region unknown
    } as any;
    reportUserBinding(steam, bridge);
    await tick();
    const log = calls.find((c) => c.op === 'logUserData');
    expect(log!.args).toEqual({ login: 'u', country: null, currency: null });
  });

  test('tolerates a steam api without getStoreCountry', async () => {
    const { calls, bridge } = fakeBridge();
    const steam = { getCurrentUserAsync: async () => ({ accountName: 'u', currency: 'RUB' }) } as any;
    reportUserBinding(steam, bridge);
    await tick();
    const log = calls.find((c) => c.op === 'logUserData');
    expect(log!.args).toEqual({ login: 'u', country: null, currency: 'RUB' });
  });

  test('does not call logUserData when no user resolves', async () => {
    const { calls, bridge } = fakeBridge();
    const steam = { getCurrentUserAsync: () => new Promise(() => {}) } as any;  // never resolves
    reportUserBinding(steam, bridge);
    await tick();
    // asserts no synchronous call while the user promise is pending; the 5s timeout→null→no-call path is covered by the production guard
    expect(calls.find((c) => c.op === 'logUserData')).toBeUndefined();
  });

  test('logs store-country currency fallback when balance currency is empty', async () => {
    const { calls, bridge } = fakeBridge();
    const steam = {
      getCurrentUserAsync: async () => ({ accountName: 'morphiv' }),   // no currency (empty wallet)
      getStoreCountry: async () => 'BY',
    } as any;
    reportUserBinding(steam, bridge);
    await tick();
    const log = calls.find((c) => c.op === 'logUserData');
    expect(log!.args).toEqual({ login: 'morphiv', country: 'BY', currency: 'USD' });
  });

  test('emits a confirming line once region resolves after boot', async () => {
    process.env['SB_USER_BINDING_CONFIRM_INTERVAL_MS'] = '1';
    process.env['SB_USER_BINDING_CONFIRM_ATTEMPTS'] = '10';
    const { calls, bridge } = fakeBridge();
    let n = 0;
    const steam = {
      getCurrentUserAsync: async () => ({ accountName: 'morphiv' }),   // zero-balance, no currency
      getStoreCountry: async () => (++n >= 3 ? 'BY' : undefined),      // cache populated after a couple polls
    } as any;
    reportUserBinding(steam, bridge);
    await new Promise((r) => setTimeout(r, 50));
    const logs = calls.filter((c) => c.op === 'logUserData');
    expect(logs.length).toBe(2);
    expect(logs[0].args).toEqual({ login: 'morphiv', country: null, currency: null });
    expect(logs[1].args).toEqual({ login: 'morphiv', country: 'BY', currency: 'USD' });
  });

  test('does not emit a second line when detection is complete at boot', async () => {
    process.env['SB_USER_BINDING_CONFIRM_INTERVAL_MS'] = '1';
    process.env['SB_USER_BINDING_CONFIRM_ATTEMPTS'] = '10';
    const { calls, bridge } = fakeBridge();
    const steam = {
      getCurrentUserAsync: async () => ({ accountName: 'u', currency: 'RUB' }),
      getStoreCountry: async () => 'RU',
    } as any;
    reportUserBinding(steam, bridge);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.op === 'logUserData').length).toBe(1);
  });

  test('stops polling when the scope is aborted (framework rollback)', async () => {
    process.env['SB_USER_BINDING_CONFIRM_INTERVAL_MS'] = '5';
    process.env['SB_USER_BINDING_CONFIRM_ATTEMPTS'] = '20';
    const { calls, bridge } = fakeBridge();
    const controller = new AbortController();
    let n = 0;
    const steam = {
      getCurrentUserAsync: async () => ({ accountName: 'u' }),      // zero-balance, incomplete at boot
      getStoreCountry: async () => (++n >= 3 ? 'BY' : undefined),   // would resolve on the 3rd poll → confirming line
    } as any;
    reportUserBinding(steam, bridge, controller.signal);
    controller.abort();                          // rollback before the poll can reach the 3rd getStoreCountry
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.op === 'logUserData').length).toBe(1);  // only the initial (none) line
  });
});
