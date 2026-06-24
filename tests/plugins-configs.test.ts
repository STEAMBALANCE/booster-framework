import { test, expect } from 'bun:test';
import { createPluginConfigs } from '../src/plugins/configs';

interface CallRecord { op: string; args: object; opts?: object }

function makeMockBridge(): { calls: CallRecord[]; call: (op: string, args?: object, opts?: object) => Promise<unknown>; notify: () => void; nextReturn: unknown } {
  const calls: CallRecord[] = [];
  const mock = {
    calls,
    nextReturn: { data: null } as unknown,
    call: async (op: string, args?: object, opts?: object) => {
      calls.push({ op, args: args ?? {}, opts });
      return mock.nextReturn;
    },
    notify: () => {},
  };
  return mock;
}

test('configs.read passes pluginId in envelope opts', async () => {
  const mockBridge = makeMockBridge();
  const configs = createPluginConfigs(mockBridge as never, 'booster-test');
  await configs.read('foo');
  expect(mockBridge.calls[0]).toEqual({
    op: 'config_read',
    args: { name: 'foo' },
    opts: { pluginId: 'booster-test' },
  });
});

test('configs.write passes pluginId + data', async () => {
  const mockBridge = makeMockBridge();
  const configs = createPluginConfigs(mockBridge as never, 'booster-test');
  await configs.write('foo', { hello: 'world' });
  expect(mockBridge.calls[0]).toEqual({
    op: 'config_write',
    args: { name: 'foo', data: { hello: 'world' } },
    opts: { pluginId: 'booster-test' },
  });
});

test('configs.read returns null when bridge returns null data', async () => {
  const mockBridge = makeMockBridge();
  // (default nextReturn is { data: null })
  const configs = createPluginConfigs(mockBridge as never, 'booster-test');
  const result = await configs.read('missing');
  expect(result).toBeNull();
});

test('configs.read returns data from bridge', async () => {
  const mockBridge = makeMockBridge();
  mockBridge.nextReturn = { data: { foo: 'bar' } };
  const configs = createPluginConfigs(mockBridge as never, 'booster-test');
  const result = await configs.read<{ foo: string }>('x');
  expect(result).toEqual({ foo: 'bar' });
});
