export interface Bridge {
  call<T = unknown>(op: string, args?: Record<string, unknown>, opts?: { pluginId?: string }): Promise<T>;
  notify(op: string, pluginId: string, args: object): void;
}

interface BridgeTransport {
  send: (json: string) => void;
}

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

declare global {
  interface Window {
    __sb_native?: (payload: string) => void;
    __sb_resolve?: (requestId: number, response: BridgeResponse) => void;
  }
}

// Defense against C++ never replying (op handler crashed, Connection dropped,
// EvalAsync silently failed). Without it, getCurrentUser and similar would
// hang forever.
const BRIDGE_TIMEOUT_MS = 10_000;
// Defense-in-depth payload cap. Native side already validates and rejects
// outsized payloads, but failing here saves a CDP round-trip and keeps the
// resolve path symmetric (we own pending cleanup).
const BRIDGE_MAX_PAYLOAD_BYTES = 64 * 1024;

// Module-level: nextId and pending are SHARED across all createBridge() calls.
// Production calls createBridge() exactly once (in index.ts bootstrap). Tests
// rely on monotonic requestId across multiple bridge instances created in
// successive test cases (see bridge.test.ts: requestId increments 1, 2, 3
// across `createBridge()` calls in the same process). Module-level state
// is correct in both contexts — the native side just echoes back whatever
// requestId we sent.
//
// Re-injection note: rollbackAll closes the relay/ui BC channels, but the
// pending map is NOT cleared here — old entries time out via BRIDGE_TIMEOUT_MS
// 10s after the last call. Acceptable bounded leak; a process-wide reset
// is overkill for the current internal-dev MVP.
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

export function createBridge(transport?: BridgeTransport): Bridge {
  const capturedNativeBridge = !transport && typeof window.__sb_native === 'function'
    ? window.__sb_native
    : undefined;

  window.__sb_resolve = (id: number, resp: BridgeResponse) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (resp.ok) p.resolve(resp.result);
    else p.reject(new Error(resp.error ?? 'unknown bridge error'));
  };

  function sendRaw(payload: string): void {
    if (transport) {
      transport.send(payload);
    } else {
      const nativeBridge = capturedNativeBridge ?? window.__sb_native;
      if (typeof nativeBridge !== 'function') {
        throw new Error('native bridge not installed');
      }
      nativeBridge(payload);
    }
  }

  return {
    call(op, args = {}, opts) {
      return new Promise((resolve, reject) => {
        const requestId = nextId++;
        const timer = setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            reject(new Error(`bridge: timeout for op '${op}' after ${BRIDGE_TIMEOUT_MS}ms`));
          }
        }, BRIDGE_TIMEOUT_MS);
        pending.set(requestId, {
          resolve: (v: unknown) => { clearTimeout(timer); (resolve as (v: unknown) => void)(v); },
          reject: (e: unknown) => { clearTimeout(timer); reject(e); },
        });
        try {
          const envelope: Record<string, unknown> = { op, args, requestId };
          if (opts?.pluginId !== undefined) {
            envelope.pluginId = opts.pluginId;
          }
          const payload = JSON.stringify(envelope);
          if (payload.length > BRIDGE_MAX_PAYLOAD_BYTES) {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(new Error('bridge: payload too large'));
            return;
          }
          sendRaw(payload);
        } catch (e) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(e);
        }
      });
    },

    notify(op: string, pluginId: string, args: object): void {
      const envelope = JSON.stringify({ op, kind: 'notify', pluginId, args });
      if (transport) {
        transport.send(envelope);
      } else {
        const nativeBridge = capturedNativeBridge ?? window.__sb_native;
        if (typeof nativeBridge !== 'function') {
          throw new Error('native bridge not installed');
        }
        nativeBridge(envelope);
      }
    },
  };
}

export function hideNativeBridgeGlobal(): void {
  try {
    Object.defineProperty(window, '__sb_native', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  } catch {
    // If the native side made the slot non-configurable, the framework cannot
    // hide it client-side; native authorization must still reject bad calls.
  }
}
