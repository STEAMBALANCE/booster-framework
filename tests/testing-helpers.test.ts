import { test, expect } from 'bun:test';
import {
  createTestPluginContext,
  ContextKind,
  Capability,
} from '../src/testing';

test('createTestPluginContext returns ctx with default capabilities', () => {
  const { ctx, cleanup } = createTestPluginContext();
  expect(ctx.pluginId).toBe('test-plugin');
  expect(ctx.contextKind).toBe(ContextKind.Main);
  // Default = all capabilities granted:
  expect(ctx.sb.ui).toBeDefined();
  expect(ctx.sb.steam).toBeDefined();
  expect(ctx.sb.configs).toBeDefined();
  expect(ctx.sb.bus).toBeDefined();
  expect(ctx.sb.pages).toBeDefined();
  cleanup();
});

test('granted: [Capability.Ui] only gives sb.ui, others undefined', () => {
  const { ctx, cleanup } = createTestPluginContext({ granted: [Capability.Ui] });
  expect(ctx.sb.ui).toBeDefined();
  expect(ctx.sb.steam).toBeUndefined();
  expect(ctx.sb.configs).toBeUndefined();
  expect(ctx.sb.bus).toBeUndefined();
  expect(ctx.sb.pages).toBeUndefined();
  cleanup();
});

test('addHeaderButton call captured in inspect.domMutations', () => {
  const { ctx, inspect, cleanup } = createTestPluginContext({
    pluginId: 'booster-test', granted: [Capability.Ui],
  });
  ctx.sb.ui.addHeaderButton({ id: 'btn1', label: 'X', onClick: () => {} });
  expect(inspect.domMutations).toHaveLength(1);
  expect(inspect.domMutations[0].kind).toBe('headerButton');
  cleanup();
});

test('bus.publish captured', () => {
  const { ctx, inspect, cleanup } = createTestPluginContext({ granted: [Capability.Bus] });
  ctx.sb.bus.publish('test.topic', { foo: 1 });
  expect(inspect.busPublishes).toEqual([{ topic: 'test.topic', data: { foo: 1 } }]);
  cleanup();
});

test('log.info captured', () => {
  const { ctx, inspect, cleanup } = createTestPluginContext();
  ctx.log.info('hello');
  expect(inspect.logEntries).toEqual([{ level: 'info', msg: 'hello', meta: undefined }]);
  cleanup();
});

test('configs.read records bridge call', async () => {
  const { ctx, inspect, cleanup } = createTestPluginContext({
    pluginId: 'booster-test', granted: [Capability.Configs],
  });
  await ctx.configs.read('myKey');
  expect(inspect.bridgeCalls).toEqual([{ op: 'config_read', args: { pluginId: 'booster-test', name: 'myKey' } }]);
  cleanup();
});

test('cleanup aborts scope.signal', () => {
  const { ctx, cleanup } = createTestPluginContext();
  expect(ctx.signal.aborted).toBe(false);
  cleanup();
  expect(ctx.signal.aborted).toBe(true);
});
