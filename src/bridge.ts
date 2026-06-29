export interface Bridge {
  call<T = unknown>(op: string, args?: Record<string, unknown>, opts?: { pluginId?: string; token?: string }): Promise<T>;
  notify(op: string, pluginId: string, args: object, opts?: { token?: string }): void;
}

/**
 * Build a bridge whose envelopes carry a fixed token (+ pluginId for
 * diagnostics). Delegates to base.call/base.notify, injecting
 * { token, pluginId } — covers both call and notify (I-2 fix: the old
 * notify(op,pluginId,args) had no token slot; wrapping here ensures every
 * envelope carries the token regardless of how the wrapper is invoked).
 */
export function createTokenBridge(base: Bridge, token: string, pluginId: string): Bridge {
  return {
    call: (op, args, opts) => base.call(op, args, { ...opts, pluginId, token }),
    notify: (op, _pid, args, opts) => base.notify(op, pluginId, args, { ...opts, token }),
  };
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

// Capture JSON.stringify at module load so a plugin that replaces
// globalThis.JSON.stringify later cannot intercept bridge envelopes.
const _JSONStringify = JSON.stringify.bind(JSON);

// Capture crypto.getRandomValues at module load so a plugin that replaces
// window.crypto cannot undermine the unguessable-requestId security property.
const _getRandomValues = crypto.getRandomValues.bind(crypto);

// Defense against C++ never replying (op handler crashed, Connection dropped,
// EvalAsync silently failed). Without it, getCurrentUser and similar would
// hang forever.
const BRIDGE_TIMEOUT_MS = 10_000;
// Defense-in-depth payload cap. Native side already validates and rejects
// outsized payloads, but failing here saves a CDP round-trip and keeps the
// resolve path symmetric (we own pending cleanup).
const BRIDGE_MAX_PAYLOAD_BYTES = 64 * 1024;

// Module-level: pending is SHARED across all createBridge() calls.
// Production calls createBridge() exactly once (in index.ts bootstrap).
// The native side echoes back whatever requestId we sent, so the random
// nonce approach is transparent to C++.
//
// Re-injection note: rollbackAll closes the relay/ui BC channels, but the
// pending map is NOT cleared here — old entries time out via BRIDGE_TIMEOUT_MS
// 10s after the last call. Acceptable bounded leak; a process-wide reset
// is overkill for the current internal-dev MVP.
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

// 53-bit nonce via two 32-bit draws, rejection-sampled into [1, 2^53-1],
// collision-checked against live pending entries.
function randomRequestId(map: Map<number, unknown>): number {
  const buf = new Uint32Array(2);
  for (;;) {
    _getRandomValues(buf);
    // 53 bits: hi (21 bits) * 2^32 + lo (32 bits)
    const id = (buf[0] % 0x200000) * 0x100000000 + buf[1];
    if (id >= 1 && id <= Number.MAX_SAFE_INTEGER && !map.has(id)) return id;
  }
}

export function createBridge(transport?: BridgeTransport, opts?: { resolverName?: string }): Bridge {
  const resolverName = opts?.resolverName;
  const resolver = (id: number, resp: BridgeResponse) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (resp.ok) p.resolve(resp.result);
    else p.reject(new Error(resp.error ?? 'unknown bridge error'));
  };
  if (resolverName) {
    Object.defineProperty(window, resolverName, {
      value: resolver,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } else {
    window.__sb_resolve = resolver;
  }

  // Capture the page-wide CDP binding once at construction. A plugin that
  // reassigns window.__sb_native afterward cannot observe envelopes or tokens
  // from other plugins' in-flight calls (anti token-harvest, B3).
  // The binding is stable across hot-updates (same function object), so
  // capturing at each bootstrap is correct. Do NOT delete the global — the
  // injector does not re-install it after a hot-update.
  const nativeSend = (typeof window.__sb_native === 'function')
    ? window.__sb_native.bind(window)
    : undefined;

  function sendRaw(payload: string): void {
    if (transport) {
      transport.send(payload);
    } else {
      if (!nativeSend) {
        throw new Error('native bridge not installed');
      }
      nativeSend(payload);
    }
  }

  return {
    call(op, args = {}, opts) {
      return new Promise((resolve, reject) => {
        const requestId = randomRequestId(pending);
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
          if (opts?.token !== undefined) {
            envelope.token = opts.token;
          }
          const payload = _JSONStringify(envelope);
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

    notify(op: string, pluginId: string, args: object, opts?: { token?: string }): void {
      const env: Record<string, unknown> = { op, kind: 'notify', pluginId, args };
      if (opts?.token !== undefined) {
        env['token'] = opts.token;
      }
      const envelope = _JSONStringify(env);
      if (transport) {
        transport.send(envelope);
      } else {
        if (!nativeSend) {
          throw new Error('native bridge not installed');
        }
        nativeSend(envelope);
      }
    },
  };
}
