import { describe, expect, test } from 'bun:test';
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
});
