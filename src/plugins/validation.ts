import type { PluginManifest } from '../api/api-types';

export interface ManifestPluginEntry {
  id: string;
  version: string;
  apiVersion: number;
  contextKinds: string[];
  urlPatterns?: string[];
  grantedCapabilities: string[];
  /** Optional flag from the signed manifest: when true the plugin
   *  ignores `userDisabledPlugins`. Used for required-by-vendor plugins
   *  (e.g. booster-checkout). Verifier enforces this can only be set by trusted
   *  manifest authors. */
  required?: boolean;
  /** Foreign bus topics the plugin is allowed to subscribe to. Each entry
   *  is either an exact topic string or a `prefix.*` glob. Own-prefix
   *  (`<pluginId>.*`) is always allowed regardless of this list. */
  subscribeTopics?: string[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Cross-validate plugin bundle's register() metadata against signed
 * manifest entry. See spec §13 H2 for the field-by-field rules table.
 */
export function crossValidate(
  bundle: PluginManifest,
  manifest: ManifestPluginEntry,
): ValidationResult {
  if (bundle.id !== manifest.id) {
    return { ok: false, reason: `id mismatch: bundle '${bundle.id}' vs manifest '${manifest.id}'` };
  }
  if (bundle.version !== manifest.version) {
    return { ok: false, reason: `version mismatch: bundle '${bundle.version}' vs manifest '${manifest.version}'` };
  }
  if (bundle.apiVersion !== manifest.apiVersion) {
    return { ok: false, reason: `api version mismatch: bundle ${bundle.apiVersion} vs manifest ${manifest.apiVersion}` };
  }
  // Bundle's contextKinds MUST be subset of manifest's.
  for (const k of bundle.contextKinds) {
    if (!manifest.contextKinds.includes(k as string)) {
      return { ok: false, reason: `contextKind '${k}' not granted by manifest` };
    }
  }
  // Bundle's urlPatterns MUST be subset of manifest's (string equality).
  if (bundle.urlPatterns && bundle.urlPatterns.length > 0) {
    const allowed = new Set(manifest.urlPatterns ?? []);
    for (const p of bundle.urlPatterns) {
      if (!allowed.has(p)) {
        return { ok: false, reason: `urlPattern '${p}' not in manifest` };
      }
    }
  }
  // capabilities NOT cross-checked (effective = intersection, computed by capability-gating.ts)
  return { ok: true };
}
