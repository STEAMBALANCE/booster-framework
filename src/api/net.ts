import type { Bridge } from '../bridge';
import type { NetApi, NetFetchInit, NetResponse } from './api-types';

interface NetFetchResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

/** Public sb.net factory. One bridge round-trip per fetch; the native
 *  `net_fetch` op enforces Capability.Net + allowedHosts by the envelope
 *  token, attaches identity headers, and returns the prefetched body. */
export function makeNetApi(bridge: Bridge): NetApi {
  return {
    async fetch(url: string, init: NetFetchInit = {}): Promise<NetResponse> {
      const args: Record<string, unknown> = { url, method: init.method ?? 'GET' };
      if (init.headers !== undefined) args.headers = init.headers;
      if (init.body !== undefined) args.body = init.body;
      if (init.timeoutMs !== undefined) args.timeoutMs = init.timeoutMs;
      // init.signal is a caller convenience for the framework scope; the
      // native op has its own timeout. Not forwarded over the bridge.
      const r = await bridge.call<NetFetchResult>('net_fetch', args);
      const body = typeof r.body === 'string' ? r.body : '';
      return {
        ok: r.ok,
        status: r.status,
        headers: r.headers ?? {},
        text: async () => body,
        json: async <T = unknown>() => JSON.parse(body) as T,
      };
    },
  };
}
