import { describe, expect, test } from 'bun:test';
import { makeAppApi } from '../src/api/app';

function fakeBridge(impl: (op: string, args?: any) => Promise<any>) {
  return { call: impl, notify: () => {} } as any;
}

describe('sb.app.getSetupId', () => {
  test('calls get_setup_id and returns the string', async () => {
    const calls: any[] = [];
    const app = makeAppApi(fakeBridge(async (op, args) => { calls.push({ op, args }); return { setupId: 'abc-123' }; }));
    expect(await app.getSetupId()).toBe('abc-123');
    expect(calls).toEqual([{ op: 'get_setup_id', args: {} }]);
  });
  test('returns undefined when setupId is null', async () => {
    const app = makeAppApi(fakeBridge(async () => ({ setupId: null })));
    expect(await app.getSetupId()).toBeUndefined();
  });
  test('returns undefined when the bridge throws', async () => {
    const app = makeAppApi(fakeBridge(async () => { throw new Error('no bridge'); }));
    expect(await app.getSetupId()).toBeUndefined();
  });
});
