import { test, expect, beforeEach } from 'bun:test';
import { resolveModuleByContent, pickExport, __resetWebpackCacheForTest } from '../src/steam-internals/webpack-modules';

function installFakeWebpack(modules: Record<string, () => any>) {
  const cache: Record<string, any> = {};
  const req: any = (id: string) => (cache[id] ??= modules[id]!());
  req.m = modules;
  (globalThis as any).window = {
    webpackChunksteamui: { push: ([, , runtime]: any[]) => { if (runtime) runtime(req); } },
  };
}

beforeEach(() => { __resetWebpackCacheForTest(); });

test('resolveModuleByContent finds a module by a signature in its factory source', () => {
  installFakeWebpack({
    '111': function () { return { a: 1 }; },               // no signature
    '222': function () { return { _route: 'Econ.GetInventoryItemsWithDescriptions#1', stub: { GetInventoryItemsWithDescriptions() {} } }; },
  });
  const mod = resolveModuleByContent('Econ.GetInventoryItemsWithDescriptions#1');
  expect(mod).toBeTruthy();
  const stub = pickExport(mod, (v: any) => v && typeof v.GetInventoryItemsWithDescriptions === 'function') as any;
  expect(typeof stub.GetInventoryItemsWithDescriptions).toBe('function');
});

test('resolveModuleByContent returns undefined when no module matches / no webpack', () => {
  installFakeWebpack({ '111': function () { return {}; } });
  expect(resolveModuleByContent('NoSuchSignature')).toBeUndefined();
  (globalThis as any).window = {};
  __resetWebpackCacheForTest();
  expect(resolveModuleByContent('anything')).toBeUndefined();
});
