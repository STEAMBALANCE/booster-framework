import type { LifecycleApi } from './api-types';
import type { Registry } from '../registry';
import type { ScopeApi } from './scope';
import { nativeWarn } from '../native-warn';

export function makeLifecycleApi(registry: Registry, scope: ScopeApi): LifecycleApi {
  let readyResolve!: () => void;
  let resolved = false;
  const readyPromise = new Promise<void>((r) => { readyResolve = r; });

  return {
    ready(): Promise<void> { return readyPromise; },
    rollbackAll(): void {
      // Abort the scope FIRST. Browser-native cleanup of listeners,
      // fetch, observers, plus our own setTimeout/setInterval shims, all
      // fire synchronously inside abort(). Registry's DOM undos run after
      // — that ordering is load-bearing because a still-live click handler
      // could otherwise re-create the DOM we're about to remove.
      try { scope._abort(); } catch { /* swallow — abort is best-effort */ }
      registry.rollbackAll();
    },
    _markReady(): void {
      if (!resolved) {
        resolved = true;
        readyResolve();
      } else {
        // Bootstrap should call this exactly once at end of injection. A
        // second call usually means the framework was eval'd twice in the
        // same JS context (the bug we already paper over via the dedup-
        // attach guard in C++ + rollbackAll on re-inject). Warn loudly so
        // we catch any regression of that machinery.
        nativeWarn('_markReady called more than once');
      }
    },
  };
}
