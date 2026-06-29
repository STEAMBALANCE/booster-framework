import type { ConfigsApi } from '../api/api-types';
import type { Bridge } from '../bridge';

/**
 * Wraps the global ConfigsApi с automatic pluginId-injection in IPC
 * envelope. Plugin can't override pluginId — bridge closure binds it.
 */
export function createPluginConfigs(bridge: Bridge, pluginId: string): ConfigsApi {
  return Object.freeze({
    async read<T = unknown>(name: string): Promise<T | null> {
      const r = await bridge.call<{ data: T | null }>('config_read',
        { name }, { pluginId });
      return r.data ?? null;
    },
    async write<T = unknown>(name: string, data: T): Promise<void> {
      await bridge.call<{ ok: true }>('config_write',
        { name, data }, { pluginId });
    },
  });
}
