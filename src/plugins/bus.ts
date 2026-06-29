import type { BusApi } from '../api/api-types';

/**
 * Wraps the global BusApi with:
 *   - publish: enforces own-prefix (topic must start with `pluginId + '.'`).
 *   - subscribe: ACL — plugin may subscribe to its own `<pluginId>.*`
 *     topics always, plus any foreign topics declared in `subscribeTopics`
 *     (exact match or `prefix.*` glob). Throws for unauthorized topics.
 * Subscriptions auto-bound to plugin scope via signal.
 */
export function createPluginBus(
  realBus: BusApi,
  pluginId: string,
  signal: AbortSignal,
  subscribeTopics: string[],
): BusApi {
  const requiredPrefix = pluginId + '.';

  function isSubscribeAllowed(topic: string): boolean {
    if (topic.startsWith(requiredPrefix)) return true;
    for (const entry of subscribeTopics) {
      if (entry.endsWith('.*')) {
        const prefix = entry.slice(0, -2);
        if (topic === prefix || topic.startsWith(prefix + '.')) return true;
      } else {
        if (topic === entry) return true;
      }
    }
    return false;
  }

  return Object.freeze({
    publish(topic: string, data?: unknown): void {
      if (!topic.startsWith(requiredPrefix)) {
        throw new Error(
          `bus.publish: topic must start with '${requiredPrefix}' (got '${topic}')`,
        );
      }
      realBus.publish(topic, data);
    },
    subscribe(topic: string, cb: (data: unknown) => void): () => void {
      if (!isSubscribeAllowed(topic)) {
        throw new Error(
          `bus.subscribe: topic '${topic}' not allowed for plugin '${pluginId}' (not own-prefix and not in subscribeTopics)`,
        );
      }
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
  });
}
