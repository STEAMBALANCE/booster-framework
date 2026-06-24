import type { AppApi } from './api-types';
import type { Bridge } from '../bridge';

// sb.app — install/app-level info. Ungated (no capability): getSetupId
// returns the injector's persistent install token (a UUID that survives
// uninstall), or undefined if the native side can't provide it.
export function makeAppApi(bridge: Bridge): AppApi {
  return {
    async getSetupId(): Promise<string | undefined> {
      try {
        const r = await bridge.call<{ setupId: string | null }>('get_setup_id', {});
        return typeof r?.setupId === 'string' ? r.setupId : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
