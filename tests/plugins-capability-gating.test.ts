import { test, expect } from 'bun:test';
import { buildGatedSb } from '../src/plugins/capability-gating';
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
    net:      { _real_net: true } as never,
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
    Capability.Bus, Capability.Pages, Capability.Keys, Capability.Net,
  ]);
  const gated = buildGatedSb(real, granted);

  for (const key of ['ui', 'steam', 'configs', 'bus', 'pages', 'keys', 'net'] as const) {
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

test('net present when Capability.Net granted', () => {
  const realSb = { net: { fetch: async () => ({}) } } as any;
  expect(buildGatedSb(realSb, new Set([Capability.Net])).net).toBe(realSb.net);
});
test('net absent when Capability.Net not granted', () => {
  const realSb = { net: {} } as any;
  expect(buildGatedSb(realSb, new Set([Capability.Ui])).net as unknown).toBeUndefined();
});
