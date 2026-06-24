//
// Mirror the native injector's manifest-entry validation.
// Adding a field here REQUIRES adding it there (and vice versa).

// KNOWN_CAPS/KNOWN_KINDS are exported so the manifest emitter and the
// approve-plugin CLI share a single source-of-truth.
export type Capability =
  | 'ui' | 'steam' | 'configs' | 'bus' | 'pages' | 'keys';
export const KNOWN_CAPS: readonly Capability[] = ['ui', 'steam', 'configs', 'bus', 'pages', 'keys'];

// Mirror booster-framework/src/api/api-types.ts::ContextKind (4 values incl.
// 'shared' for SharedJSContext relay) and the native injector's
// context-kind validation.
export type ContextKind = 'main' | 'shared' | 'tabbedBrowser' | 'web';
export const KNOWN_KINDS: readonly ContextKind[] = ['main', 'shared', 'tabbedBrowser', 'web'];

// Regex constants — exported for re-use in CLI validation (avoid
// copy-paste of semver/id regexes).
// 2-40 chars: starts with [a-z][a-z0-9], optional mid+end group [a-z0-9-]{1,38}[a-z0-9].
// Mirrors the native injector's plugin-id regex.
// No leading/trailing hyphens; second char must be alnum (not hyphen).
export const PLUGIN_ID_REGEX = /^[a-z][a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;

export interface PluginMeta {
  id: string;
  version: string;
  apiVersion: number;
  contextKinds: readonly ContextKind[];
  urlPatterns: readonly string[];
  grantedCapabilities: readonly Capability[];
}

export type ValidationResult =
  | { ok: true; meta: PluginMeta }
  | { ok: false; error: string };

export function validatePluginMeta(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'plugin meta: expected object' };
  }
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string' || !PLUGIN_ID_REGEX.test(m.id)) {
    return { ok: false, error: `plugin meta: invalid id: ${JSON.stringify(m.id)}` };
  }
  if (typeof m.version !== 'string' || !SEMVER_REGEX.test(m.version)) {
    return { ok: false, error: `plugin meta: invalid version: ${JSON.stringify(m.version)}` };
  }
  if (typeof m.apiVersion !== 'number' || !Number.isInteger(m.apiVersion) || m.apiVersion < 1) {
    return { ok: false, error: 'plugin meta: invalid apiVersion' };
  }
  if (!Array.isArray(m.contextKinds) || m.contextKinds.length === 0) {
    return { ok: false, error: 'plugin meta: contextKinds must be non-empty array' };
  }
  for (const k of m.contextKinds) {
    if (typeof k !== 'string' || !KNOWN_KINDS.includes(k as ContextKind)) {
      return { ok: false, error: `plugin meta: unknown contextKind: ${JSON.stringify(k)}` };
    }
  }
  if (!Array.isArray(m.urlPatterns)) {
    return { ok: false, error: 'plugin meta: urlPatterns must be array' };
  }
  for (const p of m.urlPatterns) {
    if (typeof p !== 'string') {
      return { ok: false, error: 'plugin meta: urlPatterns entries must be strings' };
    }
  }
  if (!Array.isArray(m.grantedCapabilities) || m.grantedCapabilities.length === 0) {
    return { ok: false, error: 'plugin meta: grantedCapabilities must be non-empty array' };
  }
  for (const c of m.grantedCapabilities) {
    if (typeof c !== 'string' || !KNOWN_CAPS.includes(c as Capability)) {
      return { ok: false, error: `plugin meta: unknown capability: ${JSON.stringify(c)}` };
    }
  }
  return { ok: true, meta: m as unknown as PluginMeta };
}
