import type { PluginsApi, PluginManifest } from './api-types';
import type { PluginRegistry } from '../plugins/registry';
import { nativeWarn } from '../native-warn';

export interface PluginsApiDeps {
  ready: Promise<void>;
}

export function createPluginsApi(
  registry: PluginRegistry,
  deps: PluginsApiDeps,
): PluginsApi {
  return {
    register(opts: PluginManifest): void {
      validateShape(opts);

      // Consume __SB_PLUGIN_BOOT__ injected by the native injector (A3).
      // The blob is one-shot: read, capture, delete — exactly once per bundle.
      const boot = (window as unknown as Record<string, unknown>)['__SB_PLUGIN_BOOT__'];
      let token: string | undefined;
      let authoritativeId: string = opts.id;

      if (boot && typeof boot === 'object') {
        const b = boot as Record<string, unknown>;
        if (typeof b['token'] === 'string' && typeof b['id'] === 'string') {
          token = b['token'];
          authoritativeId = b['id'];
        }
      }
      delete (window as unknown as Record<string, unknown>)['__SB_PLUGIN_BOOT__'];

      // C1: if the plugin self-declared a different id than the injector
      // assigned, use the injector's id as authoritative and warn.
      if (opts.id !== authoritativeId) {
        nativeWarn('plugin id mismatch', { declared: opts.id, actual: authoritativeId });
      }

      registry.add(opts, { token, authoritativeId });
    },
    ready(): Promise<void> {
      return deps.ready;
    },
  };
}

const PLUGIN_ID_RE = /^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

function validateShape(opts: PluginManifest): void {
  if (typeof opts !== 'object' || opts === null) {
    throw new Error('register: opts must be object');
  }
  if (typeof opts.id !== 'string' || !PLUGIN_ID_RE.test(opts.id)) {
    throw new Error(`register: invalid id '${opts.id}'`);
  }
  if (typeof opts.version !== 'string') {
    throw new Error('register: version required');
  }
  if (typeof opts.apiVersion !== 'number' || opts.apiVersion < 1) {
    throw new Error('register: apiVersion must be positive integer');
  }
  if (typeof opts.displayName !== 'string' || opts.displayName.length === 0) {
    throw new Error('register: displayName required');
  }
  if (!Array.isArray(opts.contextKinds) || opts.contextKinds.length === 0) {
    throw new Error('register: contextKinds must be non-empty array');
  }
  if (!Array.isArray(opts.capabilities)) {
    throw new Error('register: capabilities must be array');
  }
  if (typeof opts.init !== 'function') {
    throw new Error('register: init must be function');
  }
}
