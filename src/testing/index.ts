import {
  ContextKind, Capability,
  type SbApi, type ConfigsApi, type LogApi,
  type PluginContext, type UiApi, type SteamApi,
  type BusApi, type PagesApi,
} from '../api/api-types';

export {
  validatePluginMeta,
  KNOWN_CAPS, KNOWN_KINDS,
  PLUGIN_ID_REGEX, SEMVER_REGEX,
  type PluginMeta,
} from './plugin-meta';
import type { ScopeApi } from '../api/scope';

export { ContextKind, Capability };

export interface TestPluginContextOptions {
  pluginId?: string;
  contextKind?: ContextKind;
  apiVersion?: number;
  granted?: Capability[];
}

export interface DomMutation {
  kind: 'headerButton' | 'popup' | 'window' | 'externalWindow';
  details: object;
}

export interface BridgeCall { op: string; args: unknown }
export interface BusPublish { topic: string; data: unknown }
export interface LogEntry { level: string; msg: string; meta?: object }

export interface TestInspector {
  domMutations: DomMutation[];
  bridgeCalls: BridgeCall[];
  busPublishes: BusPublish[];
  logEntries: LogEntry[];
}

export function createTestPluginContext(opts: TestPluginContextOptions = {}): {
  ctx: PluginContext;
  inspect: TestInspector;
  cleanup: () => void;
} {
  const pluginId = opts.pluginId ?? 'test-plugin';
  const contextKind = opts.contextKind ?? ContextKind.Main;
  const apiVersion = opts.apiVersion ?? 1;
  const granted = new Set<Capability>(opts.granted ?? Object.values(Capability));

  const inspect: TestInspector = {
    domMutations: [],
    bridgeCalls: [],
    busPublishes: [],
    logEntries: [],
  };

  const ctrl = new AbortController();

  const scope: ScopeApi = {
    signal: ctrl.signal,
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number,
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id as never),
    clearInterval: (id) => globalThis.clearInterval(id as never),
    listen: (target, type, handler, options) =>
      target.addEventListener(type, handler as never, { ...(options ?? {}), signal: ctrl.signal }),
    fetch: (input, init) => globalThis.fetch(input, { ...(init ?? {}), signal: ctrl.signal }),
    abortable: <T>(p: Promise<T>) => p,
    observer: <T extends { disconnect(): void }>(o: T) => {
      ctrl.signal.addEventListener('abort', () => o.disconnect(), { once: true });
      return o;
    },
    _abort: () => ctrl.abort(),
  };

  const log: LogApi = {
    trace: (msg, meta) => inspect.logEntries.push({ level: 'trace', msg, meta }),
    debug: (msg, meta) => inspect.logEntries.push({ level: 'debug', msg, meta }),
    info:  (msg, meta) => inspect.logEntries.push({ level: 'info',  msg, meta }),
    warn:  (msg, meta) => inspect.logEntries.push({ level: 'warn',  msg, meta }),
    error: (msg, meta) => inspect.logEntries.push({ level: 'error', msg, meta }),
  };

  const configs: ConfigsApi = {
    async read<T>(name: string): Promise<T | null> {
      inspect.bridgeCalls.push({ op: 'config_read', args: { pluginId, name } });
      return null;  // tests can monkey-patch if they want data
    },
    async write<T>(name: string, data: T): Promise<void> {
      inspect.bridgeCalls.push({ op: 'config_write', args: { pluginId, name, data } });
    },
  };

  // Minimal mocks for remaining sb modules:
  const mockUi: UiApi = {
    addHeaderButton(o) {
      inspect.domMutations.push({ kind: 'headerButton', details: { ...o, id: `${pluginId}__${o.id}` } });
      return { remove: () => {}, setLabel: () => {}, setEnabled: () => {}, getRect: () => new DOMRect() };
    },
    async attachPopup(o) {
      inspect.domMutations.push({ kind: 'popup', details: o });
      return { width: o.width, height: o.height ?? 200, toggle: () => {}, show: () => {}, hide: () => {}, postMessage: () => {}, on: () => () => {}, isVisible: () => false, destroy: () => {} };
    },
    async openWindow(o) {
      inspect.domMutations.push({ kind: 'window', details: o });
      return { id: o.id, width: o.width, height: o.height, show: () => {}, hide: () => {}, close: () => {}, bringToFront: () => {}, setTitle: () => {}, isVisible: () => false, postMessage: () => {}, on: () => () => {} };
    },
    async openExternalWindow(o) {
      inspect.domMutations.push({ kind: 'externalWindow', details: o });
      return { id: o.id, setUrl: () => {}, close: () => {}, on: () => () => {} };
    },
  };

  const mockSteam: SteamApi = {
    async openUrl() {},
    getCurrentUser: () => null,
    async getCurrentUserAsync(): Promise<never> { throw new Error('test: no user'); },
    onUserChange: () => () => {},
    getStoreCountry: async () => undefined,
    getMachineId: async () => undefined,
  };

  const mockBus: BusApi = {
    publish: (topic, data) => inspect.busPublishes.push({ topic, data }),
    subscribe: () => () => {},
  };

  const mockPages: PagesApi = {
    register: () => ({ unregister: () => {} }),
  };

  const sb: SbApi = {
    version: '0.0.0-test',
    state: 'ready',
    context: { kind: contextKind, url: 'http://test.example/', onUrlChange: () => () => {} },
    app: { getSetupId: async () => undefined },
    lifecycle: { ready: async () => {}, rollbackAll: () => {}, _markReady: () => {} },
    scope,
    plugins: { register: () => {}, ready: async () => {} },
    ui:      granted.has(Capability.Ui)      ? mockUi      : (undefined as never),
    steam:   granted.has(Capability.Steam)   ? mockSteam   : (undefined as never),
    configs: granted.has(Capability.Configs) ? configs     : (undefined as never),
    bus:     granted.has(Capability.Bus)     ? mockBus     : (undefined as never),
    pages:   granted.has(Capability.Pages)   ? mockPages   : (undefined as never),
    keys:    granted.has(Capability.Keys)    ? { activate: async () => ({ ok: true, products: [], transactionId: '0' }) } : (undefined as never),
  };

  const ctx: PluginContext = {
    pluginId, contextKind, apiVersion, granted,
    sb, scope,
    // Gate ctx.configs by Capability.Configs to mirror production bootstrap
    // (see booster-framework/src/plugins/bootstrap.ts — ctx.configs is
    // createPluginConfigs(bridge, bundle.id) only when Capability.Configs is
    // granted; the helper used to expose `configs` unconditionally, which
    // hid bugs that branched on capability presence).
    configs: granted.has(Capability.Configs) ? configs : (undefined as never),
    log,
    signal: ctrl.signal,
  };

  return {
    ctx, inspect,
    cleanup: () => ctrl.abort(),
  };
}
