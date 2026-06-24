import type { Bridge } from '../bridge';
import type { ConfigsApi } from './api-types';

export function makeConfigsApi(bridge: Bridge): ConfigsApi {
  return {
    async read<T = unknown>(name: string): Promise<T | null> {
      const r = await bridge.call<{ data: T | null }>('config_read', { name });
      return r.data ?? null;
    },
    async write<T = unknown>(name: string, data: T): Promise<void> {
      await bridge.call<{ ok: true }>('config_write', { name, data });
    },
  };
}
