import { test, expect } from 'bun:test';
import { runPluginInits } from '../src/plugins/lifecycle';
import { ContextKind, Capability, type PluginManifest, type PluginContext } from '../src/api/api-types';

function makeBundle(id: string, initBehavior: (ctx: PluginContext) => unknown): PluginManifest {
  return {
    id, version: '1.0.0', apiVersion: 1,
    displayName: id, contextKinds: [ContextKind.Main],
    capabilities: [Capability.Ui],
    init: initBehavior as PluginManifest['init'],
  };
}

function makeCtx(pluginId: string): PluginContext {
  // Stub context — sufficient for these lifecycle tests
  return {
    pluginId,
    contextKind: ContextKind.Main,
    apiVersion: 1,
    granted: new Set([Capability.Ui]),
    sb: {} as never,
    scope: { signal: new AbortController().signal } as never,
    configs: {} as never,
    log: { trace(){}, debug(){}, info(){}, warn(){}, error(){} },
    signal: new AbortController().signal,
  };
}

test('runPluginInits runs all plugins even if one throws', async () => {
  let aOk = false, cOk = false;
  const plugins: PluginManifest[] = [
    makeBundle('booster-a', () => { aOk = true; }),
    makeBundle('booster-b', () => { throw new Error('intentional fail'); }),
    makeBundle('booster-c', () => { cOk = true; }),
  ];
  const results = await runPluginInits(plugins, (p) => makeCtx(p.id));
  expect(aOk).toBe(true);
  expect(cOk).toBe(true);
  expect(results.find((r) => r.pluginId === 'booster-b')?.ok).toBe(false);
  expect(results.find((r) => r.pluginId === 'booster-a')?.ok).toBe(true);
  expect(results.find((r) => r.pluginId === 'booster-c')?.ok).toBe(true);
});

test('runPluginInits collects cleanup-fns', async () => {
  let cleanups = 0;
  const plugins: PluginManifest[] = [
    makeBundle('booster-a', () => () => { cleanups++; }),
    makeBundle('booster-b', () => () => { cleanups++; }),
  ];
  const results = await runPluginInits(plugins, (p) => makeCtx(p.id));
  expect(results).toHaveLength(2);
  expect(results[0].cleanup).toBeTypeOf('function');
  for (const r of results) {
    if (r.cleanup) await r.cleanup();
  }
  expect(cleanups).toBe(2);
});

test.skip('init timeout — after 30s, lifecycle stops awaiting but plugin keeps running', async () => {
  // Skip — testing 30s timeout in unit test impractical. Implementation
  // should support an override via injection for testability.
});
