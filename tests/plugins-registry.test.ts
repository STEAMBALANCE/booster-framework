import { test, expect, beforeEach } from 'bun:test';
import { PluginRegistry } from '../src/plugins/registry';
import { ContextKind, Capability, type PluginManifest } from '../src/api/api-types';

const sample: PluginManifest = {
  id: 'booster-test',
  version: '0.1.0',
  apiVersion: 1,
  displayName: 'Test Plugin',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  init: () => undefined,
};

let registry: PluginRegistry;
beforeEach(() => {
  registry = new PluginRegistry();
});

test('add() stores plugin metadata', () => {
  registry.add(sample);
  const all = registry.list();
  expect(all).toHaveLength(1);
  expect(all[0].id).toBe('booster-test');
});

test('add() rejects duplicate id with throw', () => {
  registry.add(sample);
  expect(() => registry.add(sample)).toThrow(/already registered/);
});

test('list() returns plugins in insertion order', () => {
  registry.add({ ...sample, id: 'booster-a' });
  registry.add({ ...sample, id: 'booster-b' });
  registry.add({ ...sample, id: 'booster-c' });
  expect(registry.list().map(p => p.id)).toEqual(['booster-a', 'booster-b', 'booster-c']);
});

test('get(id) returns plugin or undefined', () => {
  registry.add(sample);
  expect(registry.get('booster-test')?.id).toBe('booster-test');
  expect(registry.get('nonexistent')).toBeUndefined();
});
