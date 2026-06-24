import type { PluginsApi, PluginManifest } from './api-types';
import type { PluginRegistry } from '../plugins/registry';

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
      registry.add(opts);
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
