import { test, expect, beforeEach } from 'bun:test';
import { createPluginsApi } from '../src/api/plugins';
import { PluginRegistry } from '../src/plugins/registry';
import { ContextKind, Capability, type PluginManifest } from '../src/api/api-types';

const sample: PluginManifest = {
  id: 'booster-test', version: '1.0.0', apiVersion: 1,
  displayName: 'Test', contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui], init: () => undefined,
};

let registry: PluginRegistry;
beforeEach(() => { registry = new PluginRegistry(); });

test('register adds to registry', () => {
  const api = createPluginsApi(registry, { ready: Promise.resolve() });
  api.register(sample);
  expect(registry.list()).toHaveLength(1);
});

test('register throws on second call with same id', () => {
  const api = createPluginsApi(registry, { ready: Promise.resolve() });
  api.register(sample);
  expect(() => api.register(sample)).toThrow(/already registered/);
});

test('ready returns the provided promise', async () => {
  const readyPromise = Promise.resolve();
  const api = createPluginsApi(registry, { ready: readyPromise });
  await expect(api.ready()).resolves.toBeUndefined();
});

test('register rejects invalid plugin id', () => {
  const api = createPluginsApi(registry, { ready: Promise.resolve() });
  expect(() => api.register({ ...sample, id: 'Invalid-ID' })).toThrow(/invalid id/);
  expect(() => api.register({ ...sample, id: '' })).toThrow(/invalid id/);
  expect(() => api.register({ ...sample, id: 'a' })).toThrow(/invalid id/);
});

test('register rejects missing required fields', () => {
  const api = createPluginsApi(registry, { ready: Promise.resolve() });
  expect(() => api.register({ ...sample, displayName: '' })).toThrow(/displayName/);
  expect(() => api.register({ ...sample, contextKinds: [] })).toThrow(/contextKinds/);
  expect(() => api.register({ ...sample, init: 'not-fn' as never })).toThrow(/init/);
});
