import { test, expect } from 'bun:test';
import { buildGatedSb, buildGlobalSb } from '../src/plugins/capability-gating';
import { Capability, type SbApi } from '../src/api/api-types';

// Minimal mock SbApi for testing.
function makeMockSb(): SbApi {
  return {
    version: '0.0.0',
    state: 'ready',
    context: {} as never,
    app:      { getSetupId: async () => undefined },
    ui:       { _real_ui: true } as never,
    steam:    { _real_steam: true } as never,
    lifecycle: {} as never,
    scope:    {} as never,
    configs:  { _real_configs: true } as never,
    bus:      { _real_bus: true } as never,
    pages:    { _real_pages: true } as never,
    plugins:  { _real_plugins: true } as never,
    keys:     { _real_keys: true } as never,
  };
}

test('grants only listed capabilities', () => {
  const real = makeMockSb();
  const gated = buildGatedSb(real, new Set([Capability.Ui, Capability.Configs]));

  expect(gated.ui).toEqual(real.ui);
  expect(gated.configs).toEqual(real.configs);
  expect(gated.steam).toBeUndefined();
  expect(gated.bus).toBeUndefined();
  expect(gated.pages).toBeUndefined();
});

test('plugins and lifecycle and scope always available', () => {
  const real = makeMockSb();
  const gated = buildGatedSb(real, new Set([]));

  expect(gated.plugins).toEqual(real.plugins);
  expect(gated.lifecycle).toEqual(real.lifecycle);
  expect(gated.scope).toEqual(real.scope);
  expect(gated.context).toEqual(real.context);
  expect(gated.version).toBe(real.version);
  expect(gated.app).toBeDefined();
});

test('all capabilities granted = full sb', () => {
  const real = makeMockSb();
  // H7 fix: explicit array (do NOT use Object.values(Capability) — TS narrowing trap)
  const granted = new Set<Capability>([
    Capability.Ui, Capability.Steam, Capability.Configs,
    Capability.Bus, Capability.Pages, Capability.Keys,
  ]);
  const gated = buildGatedSb(real, granted);

  for (const key of ['ui', 'steam', 'configs', 'bus', 'pages', 'keys'] as const) {
    expect(gated[key]).toEqual(real[key]);
  }
});

test('buildGatedSb exposes keys when granted', () => {
  const realSb = { keys: { activate: async () => ({ ok: true, products: [], transactionId: '1' }) } } as any;
  expect(buildGatedSb(realSb, new Set([Capability.Keys])).keys).toBe(realSb.keys);
});
test('buildGatedSb hides keys when not granted', () => {
  const realSb = { keys: {} } as any;
  expect(buildGatedSb(realSb, new Set()).keys).toBeUndefined();
});

test('buildGlobalSb exposes only plugin registration surface', () => {
  const real = makeMockSb();
  const globalSb = buildGlobalSb(real) as unknown as Record<string, unknown>;

  expect(globalSb.version).toBe(real.version);
  expect(globalSb.state).toBe(real.state);
  expect(globalSb.plugins).toBe(real.plugins);
  expect(globalSb.lifecycle).toBeUndefined();
  expect(globalSb.scope).toBeUndefined();
  expect(globalSb.ui).toBeUndefined();
  expect(globalSb.steam).toBeUndefined();
  expect(globalSb.configs).toBeUndefined();
  expect(globalSb.bus).toBeUndefined();
  expect(globalSb.pages).toBeUndefined();
  expect(globalSb.keys).toBeUndefined();
});
