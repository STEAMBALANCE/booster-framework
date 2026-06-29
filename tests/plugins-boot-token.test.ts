// Task A4: Boot-blob consumption, per-plugin token bridge.
// Tests for:
//   1. register() reads+deletes __SB_PLUGIN_BOOT__ → registry entry carries token + authoritativeId
//   2. C1 regression: register with lying id uses boot id as authoritative, warns
//   3. register with no boot blob → token undefined (degraded path)
//   4. createTokenBridge.call stamps token in envelope
//   5. createTokenBridge.notify stamps token in notify envelope (I-2 regression)
//   6. sec.ts readAndConsumeSec reads+deletes _sec from __SB_PLUGINS_MANIFEST__
//   7. readAndConsumeSec: deletes _sec (bootstrap simulation)
//   8. createTokenBridge: framework-internal notify carries framework token
//   9. drainPluginsOnReady: plugin gets token-bound configs

// Provide a minimal window global before any imports touch it.
// @ts-expect-error
globalThis.window = globalThis;

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createPluginsApi } from '../src/api/plugins';
import { PluginRegistry } from '../src/plugins/registry';
import { createBridge, createTokenBridge } from '../src/bridge';
import { readAndConsumeSec } from '../src/sec';
import {
  drainPluginsOnReady,
  type PluginsManifestPrefix,
  type SbApiWithOutcomes,
} from '../src/plugins/bootstrap';
import { Capability, ContextKind, type PluginManifest, type SbApi } from '../src/api/api-types';
import { createScope } from '../src/api/scope';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeBundle(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'booster-test',
    version: '1.0.0',
    apiVersion: 1,
    displayName: 'Test',
    contextKinds: [ContextKind.Main],
    capabilities: [Capability.Configs],
    init: () => undefined,
    ...over,
  };
}

function makeFakeBridge() {
  const calls: { op: string; args: unknown; opts?: unknown }[] = [];
  const notifies: { op: string; pid: string; args: unknown; opts?: unknown }[] = [];
  return {
    call: async (op: string, args?: unknown, opts?: unknown) => {
      calls.push({ op, args, opts });
      return { data: null } as unknown as never;
    },
    notify: (op: string, pid: string, args: object, opts?: unknown) => {
      notifies.push({ op, pid, args, opts });
    },
    calls,
    notifies,
  };
}

function makeFakeSb(parentCtrl: AbortController): SbApi {
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
    bus: { publish: () => {}, subscribe: () => () => {} },
    plugins: {} as never,
    keys: { activate: async () => ({} as any) },
  };
}

// ── 1. register reads+deletes __SB_PLUGIN_BOOT__ ────────────────────────────

test('register() captures token + authoritativeId from __SB_PLUGIN_BOOT__ and deletes it', () => {
  const registry = new PluginRegistry();
  const api = createPluginsApi(registry, { ready: Promise.resolve() });

  (window as any).__SB_PLUGIN_BOOT__ = { token: 'tk-abc', id: 'booster-test' };

  api.register(makeBundle());

  const entries = registry.listEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.token).toBe('tk-abc');
  expect(entries[0]!.authoritativeId).toBe('booster-test');

  // Blob must be deleted after register()
  expect((window as any).__SB_PLUGIN_BOOT__).toBeUndefined();
});

// ── 2. C1 regression: lying id → boot id wins ───────────────────────────────

test('C1: register() with lying declared id uses boot authoritativeId', () => {
  const registry = new PluginRegistry();
  const warnings: string[] = [];

  // Shim __sb_native so nativeWarn has a target to call
  const notifyEnvelopes: any[] = [];
  (window as any).__sb_native = (s: string) => { notifyEnvelopes.push(JSON.parse(s)); };

  const api = createPluginsApi(registry, { ready: Promise.resolve() });

  // Boot blob says id = 'plugin-x'; plugin self-declares 'booster-checkout'
  (window as any).__SB_PLUGIN_BOOT__ = { token: 'tkX', id: 'plugin-x' };

  // plugin-x is not booster- prefixed but passes validateShape's regex check?
  // Need a valid id per PLUGIN_ID_RE = /^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/
  // 'plugin-x' matches: p-l-u-g-i-n = ok, -x at end ok. Yes.
  api.register(makeBundle({ id: 'booster-checkout' }));

  const entries = registry.listEntries();
  expect(entries).toHaveLength(1);
  // Boot id wins:
  expect(entries[0]!.authoritativeId).toBe('plugin-x');
  expect(entries[0]!.token).toBe('tkX');

  // Blob deleted:
  expect((window as any).__SB_PLUGIN_BOOT__).toBeUndefined();

  // A warning must have been emitted (via nativeWarn → __sb_native):
  const warnEnv = notifyEnvelopes.find(
    (e) => e.op === 'log' && e.kind === 'notify' && e.args?.level === 'warn',
  );
  expect(warnEnv).toBeDefined();
  expect(warnEnv.args.meta?.declared).toBe('booster-checkout');
  expect(warnEnv.args.meta?.actual).toBe('plugin-x');

  delete (window as any).__sb_native;
});

// ── 3. register with no boot blob → token undefined ─────────────────────────

test('register() without __SB_PLUGIN_BOOT__ stores token=undefined (degraded)', () => {
  delete (window as any).__SB_PLUGIN_BOOT__;
  const registry = new PluginRegistry();
  const api = createPluginsApi(registry, { ready: Promise.resolve() });

  api.register(makeBundle());

  const entries = registry.listEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.token).toBeUndefined();
  expect(entries[0]!.authoritativeId).toBe('booster-test');
});

// ── 4. createTokenBridge.call stamps token ───────────────────────────────────

test('createTokenBridge.call stamps token in envelope', () => {
  const sent: string[] = [];
  const base = createBridge({ send: (j) => sent.push(j) });
  const tb = createTokenBridge(base, 'my-token', 'booster-x');

  void tb.call('config_read', { name: 'foo' });

  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]!);
  expect(env.op).toBe('config_read');
  expect(env.token).toBe('my-token');
  expect(env.pluginId).toBe('booster-x');
  // Cancel the pending timer by resolving the call; prevents the 10-second
  // timeout from firing as an unhandled rejection during a later test file.
  // @ts-expect-error - __sb_resolve lives on the window global
  window.__sb_resolve(env.requestId, { ok: true, result: null });
});

// ── 5. createTokenBridge.notify stamps token (I-2 regression) ────────────────

test('createTokenBridge.notify stamps token in notify envelope (I-2)', () => {
  const sent: string[] = [];
  const base = createBridge({ send: (j) => sent.push(j) });
  const tb = createTokenBridge(base, 'my-token', 'booster-x');

  // The _pid arg is ignored by createTokenBridge; it uses its own bound pluginId
  tb.notify('log', 'ignored-pid', { level: 'info', msg: 'hello' });

  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]!);
  expect(env.op).toBe('log');
  expect(env.kind).toBe('notify');
  expect(env.token).toBe('my-token');
  expect(env.pluginId).toBe('booster-x'); // bound pluginId, not 'ignored-pid'
});

// ── 6. readAndConsumeSec reads+deletes _sec ──────────────────────────────────

test('readAndConsumeSec returns frameworkToken and deletes _sec', () => {
  (globalThis as any).__SB_PLUGINS_MANIFEST__ = {
    injectorVersion: 'test',
    contextKind: 'main',
    userDisabledPlugins: [],
    plugins: [],
    _sec: { frameworkToken: 'fw-tok-123' },
  };

  const sec = readAndConsumeSec();

  expect(sec.frameworkToken).toBe('fw-tok-123');
  // _sec must be deleted
  expect((globalThis as any).__SB_PLUGINS_MANIFEST__._sec).toBeUndefined();

  delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
});

test('readAndConsumeSec returns empty object when manifest absent', () => {
  delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
  const sec = readAndConsumeSec();
  expect(sec.frameworkToken).toBeUndefined();
});

test('readAndConsumeSec returns empty object when _sec absent', () => {
  (globalThis as any).__SB_PLUGINS_MANIFEST__ = {
    injectorVersion: 'test', contextKind: 'main', userDisabledPlugins: [], plugins: [],
    // no _sec
  };
  const sec = readAndConsumeSec();
  expect(sec.frameworkToken).toBeUndefined();
  delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
});

// ── 7. drainPluginsOnReady: _sec consumed before drain ───────────────────────

test('readAndConsumeSec: deletes _sec (bootstrap simulation)', async () => {
  (globalThis as any).__SB_PLUGINS_MANIFEST__ = {
    injectorVersion: 'test',
    contextKind: 'main',
    userDisabledPlugins: [],
    plugins: [],
    _sec: { frameworkToken: 'fw-tok' },
  };

  // readAndConsumeSec is called by index.ts bootstrap, not by drainPluginsOnReady itself.
  // So here we call it explicitly to simulate the bootstrap sequence.
  readAndConsumeSec();

  // _sec should now be gone
  expect((globalThis as any).__SB_PLUGINS_MANIFEST__._sec).toBeUndefined();

  delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
});

// ── 8. drainPluginsOnReady: framework-internal notify carries framework token ─

test('createTokenBridge: framework-internal notify carries framework token end-to-end', () => {
  const sent: string[] = [];
  const base = createBridge({ send: (j) => sent.push(j) });
  const fw = createTokenBridge(base, 'fw-tok', 'booster-framework');

  fw.notify('log', 'booster-framework', { level: 'info', msg: 'x' });

  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]!);
  expect(env.op).toBe('log');
  expect(env.kind).toBe('notify');
  expect(env.token).toBe('fw-tok');
});

// ── 9. drainPluginsOnReady: plugin gets token-bound configs ──────────────────

test('drainPluginsOnReady: configs.read for token-having plugin carries token in envelope', async () => {
  const registry = new PluginRegistry();

  const fake = makeFakeBridge();
  const parentCtrl = new AbortController();
  const sb = makeFakeSb(parentCtrl);

  let configsRef: any = null;

  // Register plugin with a boot token. The init captures ctx.configs so we
  // can assert the token is carried on subsequent config_read calls.
  (window as any).__SB_PLUGIN_BOOT__ = { token: 'plug-tok', id: 'booster-test' };
  const pluginsApi = createPluginsApi(registry, { ready: Promise.resolve() });
  pluginsApi.register(makeBundle({
    capabilities: [Capability.Configs],
    init: (ctx) => { configsRef = ctx.configs; },
  }));

  const manifest: PluginsManifestPrefix = {
    injectorVersion: 'test',
    contextKind: ContextKind.Main,
    userDisabledPlugins: [],
    plugins: [{
      id: 'booster-test',
      version: '1.0.0',
      apiVersion: 1,
      contextKinds: [ContextKind.Main],
      grantedCapabilities: [Capability.Configs],
    }],
  };

  await drainPluginsOnReady({
    registry,
    manifest,
    realSb: sb,
    bridge: fake as any,
    currentUrl: 'https://example.com/',
    log: { warn: () => {}, info: () => {} },
  });

  // configsRef.read() should produce a call envelope carrying the plugin's token
  await configsRef!.read('my-key').catch(() => {});
  const configCall = fake.calls.find((c: any) => c.op === 'config_read');
  expect(configCall).toBeDefined();
  expect((configCall!.opts as any)?.token).toBe('plug-tok');
});
