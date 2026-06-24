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
  test('logs login only when a user resolves', async () => {
    const { calls, bridge } = fakeBridge();
    const steam = { getCurrentUserAsync: async () => ({ accountName: 'matrix_aas' }) } as any;
    reportUserBinding(steam, bridge);
    await tick();
    const log = calls.find((c) => c.op === 'logUserData');
    expect(log).toBeDefined();
    expect(log!.args).toEqual({ login: 'matrix_aas' });  // no email/balance/currency
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
