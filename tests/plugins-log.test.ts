import { test, expect } from 'bun:test';
import { createPluginLog } from '../src/plugins/log';

interface NotifyCall { op: string; pluginId: string; args: unknown }

function makeMockNotify(): { notify: (op: string, pluginId: string, args: unknown) => void; calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  return {
    notify: (op, pluginId, args) => { calls.push({ op, pluginId, args }); },
    calls,
  };
}

test('log.info emits notify with correct shape', () => {
  const { notify, calls } = makeMockNotify();
  const log = createPluginLog('booster-test', notify);
  log.info('hello', { x: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    op: 'log',
    pluginId: 'booster-test',
    args: { level: 'info', msg: 'hello', meta: { x: 1 } },
  });
});

test('log.error emits with level: error', () => {
  const { notify, calls } = makeMockNotify();
  const log = createPluginLog('booster-test', notify);
  log.error('boom');
  expect(calls[0].args).toEqual({ level: 'error', msg: 'boom', meta: undefined });
});

test('client-side rate limit drops above 200/sec', () => {
  const { notify, calls } = makeMockNotify();
  const log = createPluginLog('booster-test', notify);
  // Fire 250 in tight loop:
  for (let i = 0; i < 250; i++) log.info(`msg ${i}`);
  // Expect at most 200 + 1 (one drop notice) emitted
  expect(calls.length).toBeLessThanOrEqual(201);
  expect(calls.length).toBeGreaterThanOrEqual(199);
});

test('non-serializable meta is silently dropped (no throw)', () => {
  const { notify, calls } = makeMockNotify();
  const log = createPluginLog('booster-test', notify);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(() => log.info('msg', circular as object)).not.toThrow();
  // Either no call (drop) or call with sanitized meta
  if (calls.length > 0) {
    expect(typeof calls[0].args).toBe('object');
  }
});
