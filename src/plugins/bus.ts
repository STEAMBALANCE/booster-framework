import type { BusApi } from '../api/api-types';

/**
 * Wraps the global BusApi with topic-prefix enforcement on publish.
 * Subscribe has no prefix restriction (plugins may listen to any
 * topic). Subscriptions auto-bound to plugin scope via signal.
 */
export function createPluginBus(
  realBus: BusApi,
  pluginId: string,
  signal: AbortSignal,
): BusApi {
  const requiredPrefix = pluginId + '.';
  return {
    publish(topic: string, data?: unknown): void {
      if (!topic.startsWith(requiredPrefix)) {
        throw new Error(
          `bus.publish: topic must start with '${requiredPrefix}' (got '${topic}')`,
        );
      }
      realBus.publish(topic, data);
    },
    subscribe(topic: string, cb: (data: unknown) => void): () => void {
      const unsub = realBus.subscribe(topic, cb);
      // Auto-cleanup on plugin scope abort:
      if (signal.aborted) {
        unsub();
        return () => {};
      }
      // Combined cleanup: a manual unsubscribe must also drop the abort
      // listener, else it leaks on the long-lived plugin scope signal.
      // Both removeEventListener and unsub are idempotent.
      const cleanup = () => {
        signal.removeEventListener('abort', cleanup);
        unsub();
      };
      signal.addEventListener('abort', cleanup, { once: true });
      return cleanup;
    },
  };
}
