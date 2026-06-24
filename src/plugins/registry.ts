import type { PluginManifest } from '../api/api-types';

/**
 * Stores plugin metadata as registered via sb.plugins.register().
 * Insertion-order-preserving. Used by lifecycle.ts to iterate plugins
 * for init/cleanup.
 */
export class PluginRegistry {
  private entries: PluginManifest[] = [];

  add(plugin: PluginManifest): void {
    if (this.entries.some((p) => p.id === plugin.id)) {
      throw new Error(`plugin '${plugin.id}' already registered`);
    }
    this.entries.push(plugin);
  }

  get(id: string): PluginManifest | undefined {
    return this.entries.find((p) => p.id === id);
  }

  list(): readonly PluginManifest[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }
}
