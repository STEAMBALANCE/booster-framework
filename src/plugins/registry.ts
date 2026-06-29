import type { PluginManifest } from '../api/api-types';

/**
 * Extended per-entry shape that carries the injector-assigned authoritative id
 * and optional token (from __SB_PLUGIN_BOOT__). Introduced in A4.
 */
export interface RegistryEntry {
  manifest: PluginManifest;
  /** Injector-assigned id from __SB_PLUGIN_BOOT__. Equals manifest.id when
   *  no boot blob was present or the plugin's self-declared id was correct. */
  authoritativeId: string;
  /** Per-plugin token from __SB_PLUGIN_BOOT__. Undefined in degraded mode
   *  (no boot blob — pre-A3 injector or missing prefix). */
  token?: string;
}

/**
 * Stores plugin metadata as registered via sb.plugins.register().
 * Insertion-order-preserving. Used by lifecycle.ts to iterate plugins
 * for init/cleanup.
 */
export class PluginRegistry {
  private entries: RegistryEntry[] = [];

  add(plugin: PluginManifest, meta?: { token?: string; authoritativeId?: string }): void {
    const authId = meta?.authoritativeId ?? plugin.id;
    if (this.entries.some((e) => e.authoritativeId === authId)) {
      throw new Error(`plugin '${authId}' already registered`);
    }
    this.entries.push({ manifest: plugin, authoritativeId: authId, token: meta?.token });
  }

  get(id: string): PluginManifest | undefined {
    return this.entries.find((e) => e.authoritativeId === id)?.manifest;
  }

  /** Returns manifests in insertion order (backward-compat accessor). */
  list(): readonly PluginManifest[] {
    return this.entries.map((e) => e.manifest);
  }

  /** Returns full entries including authoritativeId + token. Use in bootstrap. */
  listEntries(): readonly RegistryEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }
}
