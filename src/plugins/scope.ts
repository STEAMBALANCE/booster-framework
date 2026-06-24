import { createScope } from '../api/scope';
import type { ScopeApi } from '../api/scope';

/**
 * Per-plugin scope. Cascades abort from parent (framework) signal.
 * Returns standard ScopeApi (timers, listeners, fetch, observers) bound
 * to the per-plugin AbortController.
 */
export function createPluginScope(
  parentSignal: AbortSignal,
  _pluginId: string,
): ScopeApi & { _abort: () => void } {
  const ctrl = new AbortController();
  // Cascade: parent abort triggers nested abort.
  if (parentSignal.aborted) {
    ctrl.abort();
  } else {
    parentSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  // Delegate full ScopeApi impl to existing createScope, but with our
  // controller's signal as the lifetime anchor. _abort() lets framework
  // explicitly cancel this plugin (e.g. user-disable, hot-swap).
  const scope = createScope(ctrl);
  return Object.assign(scope, { _abort: () => ctrl.abort() });
}
