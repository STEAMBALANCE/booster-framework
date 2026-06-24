import type { PluginManifest, PluginContext } from '../api/api-types';

// NB (B5 fix): renamed from internal `InitResult` (which collided with the
// PUBLIC `InitResult` exported by api-types.ts — that one describes plugin's
// init return type, void | cleanup-fn). This struct describes what the
// lifecycle orchestrator collects from each run.
export interface PluginInitOutcome {
  pluginId: string;
  ok: boolean;
  error?: string;
  cleanup?: () => void | Promise<void>;
}

const INIT_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Run all plugins' init in registration order. Catches per-plugin errors;
 * other plugins continue. Returns array of PluginInitOutcome with cleanup-fns
 * for successful plugins.
 *
 * H2 fix: pending init promise gets a .catch() to suppress
 * unhandledRejection if it eventually throws after timeout. Cleanup-fn
 * returned post-timeout is dropped (plugin's DOM mutations are still
 * collected by framework registry and rolled back on rollbackAll).
 */
export async function runPluginInits(
  plugins: readonly PluginManifest[],
  makeContext: (plugin: PluginManifest) => PluginContext,
): Promise<PluginInitOutcome[]> {
  const results: PluginInitOutcome[] = [];
  for (const plugin of plugins) {
    const ctx = makeContext(plugin);
    try {
      const initPromise = Promise.resolve(plugin.init(ctx));
      // Suppress unhandled-rejection if init rejects after timeout:
      initPromise.catch(() => { /* swallow late rejection */ });
      const initResult = await Promise.race([
        initPromise,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), INIT_TIMEOUT_MS),
        ),
      ]);
      const cleanup = (typeof initResult === 'function') ? initResult : undefined;
      results.push({ pluginId: plugin.id, ok: true, cleanup });
    } catch (e) {
      results.push({ pluginId: plugin.id, ok: false, error: String(e) });
    }
  }
  return results;
}

/**
 * Run all cleanup-fns in REVERSE order (LIFO). Per-cleanup 5s timeout.
 * Errors caught and ignored (logged at callsite).
 */
export async function runPluginCleanups(
  results: readonly PluginInitOutcome[],
): Promise<void> {
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (!r.cleanup) continue;
    try {
      await Promise.race([
        Promise.resolve(r.cleanup()),
        new Promise<void>((resolve) => setTimeout(() => resolve(), CLEANUP_TIMEOUT_MS)),
      ]);
    } catch {
      // Errors in cleanup are logged at the higher level; here we just
      // ensure one bad cleanup doesn't block others.
    }
  }
}
