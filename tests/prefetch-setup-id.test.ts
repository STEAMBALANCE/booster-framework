import { describe, expect, test } from 'bun:test';
import { prefetchSetupId } from '../src/prefetch-setup-id';
const tick = () => new Promise((r) => setTimeout(r, 0));
// Drain several macrotasks so the recursive-setTimeout retry chain can run
// to completion under backoffMs:()=>0.
const drain = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };

describe('prefetchSetupId', () => {
  test('sets the global when getSetupId resolves on the first attempt', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => 'uuid-1' }, win, { maxAttempts: 1 });
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBe('uuid-1');
  });
  test('leaves global unset when getSetupId resolves undefined (single attempt)', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => undefined }, win, { maxAttempts: 1 });
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
  });
  test('ignores a CRLF-bearing value (single attempt)', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => 'a\r\nb' }, win, { maxAttempts: 1 });
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
  });
  test('never throws when getSetupId rejects (single attempt)', async () => {
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    expect(() => prefetchSetupId({ getSetupId: async () => { throw new Error('x'); } }, win, { maxAttempts: 1 })).not.toThrow();
    await tick();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
  });

  // Retry: the SetupId can be momentarily unavailable on cold start (registry
  // read lag / first-launch write race). Retry until a non-empty value lands
  // so window.__SB_BOOSTER_UUID__ — the source for x-booster-uuid everywhere —
  // is reliably set.
  test('retries until getSetupId yields a value', async () => {
    let n = 0;
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => (++n < 3 ? undefined : 'uuid-late') }, win, { maxAttempts: 6, backoffMs: () => 0 });
    await drain();
    expect(win.__SB_BOOSTER_UUID__).toBe('uuid-late');
  });
  test('retries past a rejection then succeeds', async () => {
    let n = 0;
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => { if (++n < 2) throw new Error('transient'); return 'uuid-ok'; } }, win, { maxAttempts: 6, backoffMs: () => 0 });
    await drain();
    expect(win.__SB_BOOSTER_UUID__).toBe('uuid-ok');
  });
  test('gives up after maxAttempts (bounded — no infinite loop)', async () => {
    let n = 0;
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => { n++; return undefined; } }, win, { maxAttempts: 3, backoffMs: () => 0 });
    await drain();
    expect(win.__SB_BOOSTER_UUID__).toBeUndefined();
    expect(n).toBe(3);
  });
  test('stops retrying once a value is found (no extra getSetupId calls)', async () => {
    let n = 0;
    const win: { __SB_BOOSTER_UUID__?: string } = {};
    prefetchSetupId({ getSetupId: async () => { n++; return 'uuid-first'; } }, win, { maxAttempts: 5, backoffMs: () => 0 });
    await drain();
    expect(win.__SB_BOOSTER_UUID__).toBe('uuid-first');
    expect(n).toBe(1);
  });
});
