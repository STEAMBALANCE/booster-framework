// Integration test for the plugin-bootstrap drain. Verifies that
// drainPluginsOnReady:
//   - skips when manifest is absent (stashes empty outcomes)
//   - filters by contextKind / apiVersion / urlPatterns / cross-validation
//   - skips user-disabled (unless `required`)
//   - assembles a PluginContext with the per-plugin wrappers (bus topic
//     prefix, ui id prefix, configs envelope) and runs init
//   - stashes outcomes on realSb._pluginOutcomes for later rollback
//
// We don't exercise the real bridge/IPC layer — `fakeBridge` records call
// args; the per-plugin sb modules' own unit tests cover those wrappers
// against the real-shape contract.

import { test, expect, beforeEach } from 'bun:test';
import {
  drainPluginsOnReady,
  filterEligiblePlugins,
  readPluginsManifest,
  type PluginsManifestPrefix,
  type SbApiWithOutcomes,
} from '../src/plugins/bootstrap';
import { PluginRegistry } from '../src/plugins/registry';
import {
  Capability,
  ContextKind,
  type PluginManifest,
  type SbApi,
} from '../src/api/api-types';
import { createScope } from '../src/api/scope';
import type { Bridge } from '../src/bridge';

// ── helpers ─────────────────────────────────────────────────────────────

function makeFakeBridge(): Bridge & { calls: { op: string; args: unknown; opts?: unknown }[]; notifies: { op: string; pid: string; args: unknown }[] } {
  const calls: { op: string; args: unknown; opts?: unknown }[] = [];
  const notifies: { op: string; pid: string; args: unknown }[] = [];
  return {
    call: async (op, args, opts) => {
      calls.push({ op, args, opts });
      // Return a benign shape that satisfies bus/configs callers (none
      // exercised in these tests, but defended in depth).
      return { data: null } as unknown as never;
    },
    notify: (op, pid, args) => { notifies.push({ op, pid, args }); },
    calls,
    notifies,
  } as unknown as Bridge & { calls: { op: string; args: unknown; opts?: unknown }[]; notifies: { op: string; pid: string; args: unknown }[] };
}

function makeFakeSb(parentCtrl: AbortController): SbApi {
  // Use a real scope so per-plugin createPluginScope can cascade from
  // parentSignal correctly (it calls addEventListener on the signal).
  const scope = createScope(parentCtrl);
  return {
    version: 'test',
    state: 'ready',
    context: {} as never,
    ui: {
      addHeaderButton: () => ({ remove() {}, setLabel() {}, setEnabled() {}, getRect: () => new DOMRect() }),
      attachPopup: () => Promise.resolve({} as never),
      openWindow: () => Promise.resolve({} as never),
      openExternalWindow: () => Promise.resolve({} as never),
    } as never,
    steam: {} as never,
    lifecycle: {} as never,
    scope,
    configs: {} as never,
    pages: {} as never,
    bus: {
      publish: () => {},
      subscribe: () => () => {},
    },
    plugins: {} as never,
  };
}

function makeBundle(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'booster-test',
    version: '1.0.0',
    apiVersion: 1,
    displayName: 'Test',
    contextKinds: [ContextKind.Main],
    capabilities: [Capability.Ui],
    init: () => undefined,
    ...over,
  };
}

let registry: PluginRegistry;
let parentCtrl: AbortController;
let sb: SbApi;
let bridge: ReturnType<typeof makeFakeBridge>;

beforeEach(() => {
  registry = new PluginRegistry();
  parentCtrl = new AbortController();
  sb = makeFakeSb(parentCtrl);
  bridge = makeFakeBridge();
});

// ── tests ───────────────────────────────────────────────────────────────

// Regression: drainPluginsOnReady is invoked on a `lifecycle.ready()`
// microtask scheduled inside the framework's IIFE. Plugin bundles are
// evaluated by the native injector in SEPARATE Runtime.evaluate calls AFTER
// the framework's eval returns — each one is its own V8 task, so microtasks
// drain between them. Without a wait-for-plugins step, the drain fires
// BEFORE plugin bundles call sb.plugins.register and produces zero outcomes
// (silent failure: the «Пополнить» button never appears).
test('drainPluginsOnReady waits for plugins that register after drain begins', async () => {
  // Schedule late registration (50ms after drain starts) to model the
  // separate-Runtime.evaluate race.
  setTimeout(() => {
    registry.add(makeBundle({ id: 'booster-late' }));
  }, 50);

  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-late', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui],
      required: true,
    }],
  };
  // Registry is empty at drain start. The fix waits until the registry
  // catches up with manifest.plugins.length (or a soft timeout).
  const outcomes = await drainPluginsOnReady({
    registry,
    manifest,
    realSb: sb,
    bridge,
    currentUrl: 'https://example.com/',
    log: { warn: () => {}, info: () => {} },
  });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.pluginId).toBe('booster-late');
  expect(outcomes[0]?.ok).toBe(true);
});

test('drainPluginsOnReady with absent manifest stashes empty outcomes and warns', async () => {
  const warnings: string[] = [];
  const outcomes = await drainPluginsOnReady({
    registry,
    manifest: undefined,
    realSb: sb,
    bridge,
    currentUrl: 'https://example.com/',
    log: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(outcomes).toEqual([]);
  expect((sb as SbApiWithOutcomes)._pluginOutcomes).toEqual([]);
  expect(warnings.some((w) => w.includes('__SB_PLUGINS_MANIFEST__ missing'))).toBe(true);
});

test('filterEligiblePlugins skips registered-but-not-in-manifest', () => {
  registry.add(makeBundle());
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [], // empty — registered bundle has no manifest entry
  };
  const warnings: string[] = [];
  const eligible = filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://example.com/',
    log: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(eligible).toHaveLength(0);
  expect(warnings.some((w) => w.includes('not in manifest'))).toBe(true);
});

test('filterEligiblePlugins skips user-disabled when not required', () => {
  registry.add(makeBundle());
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: ['booster-test'],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui],
    }],
  };
  const eligible = filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://example.com/',
  });
  expect(eligible).toHaveLength(0);
});

test('filterEligiblePlugins keeps user-disabled when required', () => {
  registry.add(makeBundle());
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: ['booster-test'],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui],
      // required: true ignores user-disable
      required: true,
    }],
  };
  const eligible = filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://example.com/',
  });
  expect(eligible).toHaveLength(1);
});

test('filterEligiblePlugins skips wrong contextKind', () => {
  registry.add(makeBundle({ contextKinds: [ContextKind.Shared] }));
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Shared],
      grantedCapabilities: [Capability.Ui],
    }],
  };
  const eligible = filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://example.com/',
  });
  expect(eligible).toHaveLength(0);
});

test('filterEligiblePlugins skips unsupported apiVersion', () => {
  registry.add(makeBundle({ apiVersion: 999 }));
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 999,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui],
    }],
  };
  const warnings: string[] = [];
  const eligible = filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://example.com/',
    log: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(eligible).toHaveLength(0);
  expect(warnings.some((w) => w.includes('apiVersion 999 not supported'))).toBe(true);
});

test('filterEligiblePlugins skips on cross-validation failure (version mismatch)', () => {
  registry.add(makeBundle({ version: '1.0.0' }));
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '2.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui],
    }],
  };
  const warnings: string[] = [];
  const eligible = filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://example.com/',
    log: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(eligible).toHaveLength(0);
  expect(warnings.some((w) => w.includes('cross-validation failed'))).toBe(true);
});

test('filterEligiblePlugins keeps plugin only when urlPatterns match', () => {
  registry.add(makeBundle({ urlPatterns: ['^https://shop\\.example\\.com/'] }));
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      urlPatterns: ['^https://shop\\.example\\.com/'],
      grantedCapabilities: [Capability.Ui],
    }],
  };
  // No match:
  expect(filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://other.example.com/',
  })).toHaveLength(0);
  // Match:
  expect(filterEligiblePlugins({
    registry, manifest, currentUrl: 'https://shop.example.com/cart',
  })).toHaveLength(1);
});

test('drainPluginsOnReady runs init for eligible plugin with capability-intersected ctx', async () => {
  let receivedGranted: ReadonlySet<Capability> | undefined;
  let receivedPluginId: string | undefined;
  let receivedSbHasBus = false;
  let receivedSbHasUi = false;
  const bundle = makeBundle({
    capabilities: [Capability.Ui, Capability.Bus, Capability.Steam], // request 3
    init: (ctx) => {
      receivedGranted = ctx.granted;
      receivedPluginId = ctx.pluginId;
      receivedSbHasBus = ctx.sb.bus !== undefined;
      receivedSbHasUi = ctx.sb.ui !== undefined;
    },
  });
  registry.add(bundle);
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui, Capability.Bus], // grant 2 (Steam denied)
    }],
  };
  const outcomes = await drainPluginsOnReady({
    registry, manifest, realSb: sb, bridge,
    currentUrl: 'https://example.com/',
  });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0].ok).toBe(true);
  expect(receivedPluginId).toBe('booster-test');
  // Effective grant = (requested ∩ granted) = {Ui, Bus}
  expect(receivedGranted?.has(Capability.Ui)).toBe(true);
  expect(receivedGranted?.has(Capability.Bus)).toBe(true);
  expect(receivedGranted?.has(Capability.Steam)).toBe(false);
  expect(receivedSbHasBus).toBe(true);
  expect(receivedSbHasUi).toBe(true);
});

test('drainPluginsOnReady wraps bus with topic-prefix enforcement', async () => {
  let busPublishThrew = false;
  const bundle = makeBundle({
    capabilities: [Capability.Bus],
    init: (ctx) => {
      try {
        // Should throw — topic 'foo' doesn't start with 'booster-test.'
        ctx.sb.bus.publish('foo', { x: 1 });
      } catch {
        busPublishThrew = true;
      }
    },
  });
  registry.add(bundle);
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test', contextKind: ContextKind.Main, userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Bus],
    }],
  };
  await drainPluginsOnReady({
    registry, manifest, realSb: sb, bridge,
    currentUrl: 'https://example.com/',
  });
  expect(busPublishThrew).toBe(true);
});

test('drainPluginsOnReady uses per-plugin configs for ctx.configs and ctx.sb.configs', async () => {
  let sameConfigObject = false;
  const bundle = makeBundle({
    capabilities: [Capability.Configs],
    init: async (ctx) => {
      sameConfigObject = ctx.sb.configs === ctx.configs;
      await ctx.sb.configs.write('settings', { enabled: true });
      await ctx.configs.read('settings');
    },
  });
  registry.add(bundle);
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test', contextKind: ContextKind.Main, userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Configs],
    }],
  };

  await drainPluginsOnReady({
    registry, manifest, realSb: sb, bridge,
    currentUrl: 'https://example.com/',
  });

  expect(sameConfigObject).toBe(true);
  expect(bridge.calls).toEqual([
    { op: 'config_write', args: { name: 'settings', data: { enabled: true } }, opts: { pluginId: 'booster-test' } },
    { op: 'config_read', args: { name: 'settings' }, opts: { pluginId: 'booster-test' } },
  ]);
});

test('drainPluginsOnReady stashes outcomes on realSb._pluginOutcomes', async () => {
  const bundle = makeBundle({ init: () => () => { /* cleanup */ } });
  registry.add(bundle);
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test', contextKind: ContextKind.Main, userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test', version: '1.0.0', apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Ui],
    }],
  };
  await drainPluginsOnReady({
    registry, manifest, realSb: sb, bridge,
    currentUrl: 'https://example.com/',
  });
  const stashed = (sb as SbApiWithOutcomes)._pluginOutcomes;
  expect(stashed).toBeDefined();
  expect(stashed).toHaveLength(1);
  expect(stashed?.[0].ok).toBe(true);
  expect(typeof stashed?.[0].cleanup).toBe('function');
});

test('drainPluginsOnReady continues after one plugin init throws', async () => {
  const bundleA = makeBundle({ id: 'booster-a', init: () => { throw new Error('A boom'); } });
  let bRan = false;
  const bundleB = makeBundle({ id: 'booster-b', init: () => { bRan = true; } });
  registry.add(bundleA);
  registry.add(bundleB);
  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test', contextKind: ContextKind.Main, userDisabledPlugins: [],
    plugins: [
      { id: 'booster-a', version: '1.0.0', apiVersion: 1, contextKinds: [ContextKind.Main], grantedCapabilities: [Capability.Ui] },
      { id: 'booster-b', version: '1.0.0', apiVersion: 1, contextKinds: [ContextKind.Main], grantedCapabilities: [Capability.Ui] },
    ],
  };
  const outcomes = await drainPluginsOnReady({
    registry, manifest, realSb: sb, bridge,
    currentUrl: 'https://example.com/',
  });
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0].ok).toBe(false);
  expect(outcomes[0].error).toContain('A boom');
  expect(outcomes[1].ok).toBe(true);
  expect(bRan).toBe(true);
});

test('readPluginsManifest returns undefined when global is unset', () => {
  delete (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__;
  expect(readPluginsManifest()).toBeUndefined();
});

test('readPluginsManifest returns prefix when shape is valid', () => {
  (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__ = {
    injectorVersion: '1.2.3',
    contextKind: 'main',
    userDisabledPlugins: [],
    plugins: [],
  };
  const m = readPluginsManifest();
  expect(m).toBeDefined();
  expect(m?.injectorVersion).toBe('1.2.3');
  delete (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__;
});

test('readPluginsManifest returns undefined on malformed shape', () => {
  (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__ = {
    injectorVersion: 'x', /* missing contextKind */ userDisabledPlugins: [], plugins: [],
  };
  expect(readPluginsManifest()).toBeUndefined();
  delete (globalThis as { __SB_PLUGINS_MANIFEST__?: unknown }).__SB_PLUGINS_MANIFEST__;
});
