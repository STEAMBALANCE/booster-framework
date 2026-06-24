import { describe, expect, test } from 'bun:test';
import { prefetchSetupId } from '../src/prefetch-setup-id';
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('prefetchSetupId', () => {
  test('sets the global when getSetupId resolves', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => 'uuid-1' }, win);
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBe('uuid-1');
  });
  test('leaves global unset when getSetupId resolves undefined', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => undefined }, win);
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
  });
  test('ignores a CRLF-bearing value', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => 'a\r\nb' }, win);
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
  });
  test('never throws when getSetupId rejects', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    expect(() => prefetchSetupId({ getSetupId: async () => { throw new Error('x'); } }, win)).not.toThrow();
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
  });
});
