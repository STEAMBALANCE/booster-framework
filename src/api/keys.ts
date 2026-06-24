import type { KeysApi, ActivateOutcome } from './api-types';
import type { Registry } from '../registry';
import { RELAY_CHANNEL } from '../relay/protocol';
import { readRelayAuthToken, withRelayAuth } from '../relay/auth';

const KEYS_REQUEST_ID_BASE = 300_000;

/** Read at call-time so tests can shorten it via env without import-time
 *  pinning. Production CEF lacks `process` → defaults to 35000ms (≥ the relay's
 *  30s send timeout + margin, so the main shell never gives up while a
 *  non-idempotent send is still in flight). */
function relayTimeoutMs(): number {
  if (typeof process === 'undefined') return 35_000;
  const env = Number(process.env['SB_KEYS_RELAY_TIMEOUT_MS']);
  return Number.isFinite(env) && env > 0 ? env : 35_000;
}

/** Thrown when activation could not be confirmed (no connection / timeout /
 *  relay error / rollback). The activation status is UNKNOWN — callers must not retry. */
export class KeyActivationTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'KeyActivationTransportError'; }
}

export function makeKeysApi(registry: Registry): KeysApi {
  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const relayAuthToken = readRelayAuthToken();
  let nextRequestId = KEYS_REQUEST_ID_BASE;
  const pending = new Map<number, { reject: (e: Error) => void; cleanup: () => void }>();

  registry.push({
    description: 'keys-bc',
    undo: () => {
      for (const p of [...pending.values()]) {
        p.cleanup();
        try { p.reject(new KeyActivationTransportError('framework rolled back')); } catch { /* */ }
      }
      pending.clear();
      try { bc.close(); } catch { /* */ }
    },
  });

  return {
    async activate(productKey: string): Promise<ActivateOutcome> {
      if (typeof productKey !== 'string' || productKey.length === 0) throw new Error('invalid product key (empty)');
      if (productKey.length > 256) throw new Error('invalid product key (too long)');
      const requestId = nextRequestId++;
      return new Promise<ActivateOutcome>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); bc.removeEventListener('message', handler); pending.delete(requestId); };
        const timer = setTimeout(() => {
          cleanup();
          reject(new KeyActivationTransportError('activation timeout — status unknown, do not retry'));
        }, relayTimeoutMs());
        const handler = (ev: MessageEvent) => {
          const m = ev.data as { kind?: string; requestId?: number; outcome?: ActivateOutcome; error?: string } | undefined;
          if (m?.requestId !== requestId) return;
          if (m.kind === 'activate-product-key-ok') { cleanup(); resolve(m.outcome!); }
          else if (m.kind === 'activate-product-key-error') { cleanup(); reject(new KeyActivationTransportError(m.error ?? 'activation transport failure')); }
        };
        pending.set(requestId, { reject, cleanup });
        bc.addEventListener('message', handler);
        bc.postMessage(withRelayAuth({ kind: 'activate-product-key', requestId, key: productKey }, relayAuthToken));
      });
    },
  };
}
