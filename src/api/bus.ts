import type { BusApi } from './api-types';
import type { Bridge } from '../bridge';
import type { ScopeApi } from './scope';
import { nativeWarn } from '../native-warn';

// Build-time define from bun's `define` map (framework/build.ts). False in
// dev builds, true in production. Used to gate the dev-only unmatched-topic
// warning below — bun's minifier dead-code-eliminates the branch in prod.
declare const __SB_PRODUCTION__: boolean;

const TOPIC_RE = /^[a-z][a-z0-9.\-]{0,63}$/;
// MUST mirror the native injector's bus max payload size (16 KB).
const MAX_PAYLOAD_BYTES = 16 * 1024;

declare global {
  interface Window {
    __sb_bus_dispatch?: (topic: string, data: unknown) => void;
  }
}

export function makeBusApi(scope: ScopeApi, bridge: Bridge, dispatchName?: string): BusApi {
  const subscribers = new Map<string, Set<(d: unknown) => void>>();

  // Install dispatch entry-point. C++ broadcasts call this on each target
  // via window["<dispatchName>"](...) (bracket notation, B6).
  // When dispatchName is provided (per-launch secret name from _sec), register
  // non-enumerable under that name so it's immune to enumeration and plugin
  // overwrites of window.__sb_bus_dispatch. Fall back to the legacy global
  // name when not provided (back-compat for pre-B4 injectors / tests).
  const _dispatchName = dispatchName ?? '__sb_bus_dispatch';
  // Deliver to THIS context's local subscribers only. No unmatched-topic warn:
  // used both by the native fanout path (via _dispatchFn) and by publish's
  // local-echo (C1) — a publish whose own context has no subscriber is normal,
  // not a typo, so it must stay silent.
  const deliverLocal = (topic: string, data: unknown) => {
    const set = subscribers.get(topic);
    if (!set) return;
    for (const cb of set) {
      try { cb(data); }
      catch (e) {
        // Errors in subscriber callbacks must NOT propagate — they would
        // halt the dispatch loop and starve other subscribers of this
        // topic. Log via console.error so a faulty subscriber surfaces
        // in dev/prod telemetry instead of silently dropping events.
        // Was a `// swallow` no-op pre-2026-05-21 — see code-review
        // I-2/I-5 from that day.
        console.error(`[sb.bus] subscriber threw for topic '${topic}'`, e);
      }
    }
  };
  // Native broadcast entry-point. C++ calls this on each target via
  // window["<dispatchName>"](...). Keeps the dev-only unmatched-topic warn —
  // a remote broadcast for a topic nobody here subscribed to is a likely
  // publish/subscribe typo across targets.
  const _dispatchFn = (topic: string, data: unknown) => {
    if (!subscribers.get(topic)) {
      // Dev-only diagnostic: a remote broadcast arrived for a topic this
      // target never subscribed to. Common cause is a typo in publish /
      // subscribe pairing across targets. Dead-code-eliminated in prod
      // builds (bun's minifier drops the if-block when __SB_PRODUCTION__
      // is constant-true). The `typeof !== 'undefined'` guard mirrors
      // the established pattern in framework/src/relay/*.ts so direct
      // `bun test` runs (no bun-define replacement) don't ReferenceError.
      if (typeof __SB_PRODUCTION__ === 'undefined' || !__SB_PRODUCTION__) {
        // nativeWarn (rather than console.warn) routes through the C++
        // log sink so the warning is observable even when DevTools is
        // closed — matches the established pattern in framework/src/
        // relay/*.ts. Dead-code-eliminated by bun's minifier in prod.
        nativeWarn(`sb.bus: unmatched topic '${topic}' (no subscribers)`);
      }
      return;
    }
    deliverLocal(topic, data);
  };
  // Register the dispatch function. When a per-launch secret name is given,
  // install non-enumerable+configurable via defineProperty so a plugin can't
  // observe or overwrite it via enumeration or assignment. With the default
  // legacy name, use a plain assignment (back-compat: pre-B4 injectors and
  // older tests call `window.__sb_bus_dispatch` directly).
  if (dispatchName) {
    Object.defineProperty(globalThis, _dispatchName, {
      value: _dispatchFn,
      enumerable: false,
      configurable: true,
    });
  } else {
    (globalThis as { __sb_bus_dispatch?: (t: string, d: unknown) => void })
      .__sb_bus_dispatch = _dispatchFn;
  }
  scope.signal.addEventListener('abort', () => {
    subscribers.clear();
    // Don't delete the global handler — next bootstrap overwrites with
    // a fresh closure. Deleting here could break a still-firing broadcast.
  }, { once: true });

  return {
    publish(topic: string, data: unknown = null): void {
      if (!TOPIC_RE.test(topic))
        throw new Error(`sb.bus.publish: invalid topic '${topic}'`);
      let json: string;
      try { json = JSON.stringify(data ?? null); }
      catch (e) { throw new Error(`sb.bus.publish: data not JSON-serializable: ${e}`); }
      // C++ counts UTF-8 bytes (kBusMaxPayloadBytes). JS .length is UTF-16
      // code units — a Russian-text payload could be under the cap by
      // .length and over by .byteLength, slipping past the TS guard and
      // tripping the native one with a confusing error. Match the wire unit.
      const byteLen = new TextEncoder().encode(json).byteLength;
      if (byteLen > MAX_PAYLOAD_BYTES)
        throw new Error(`sb.bus.publish: payload too large (${byteLen} > ${MAX_PAYLOAD_BYTES})`);
      bridge.call('bus.publish', { topic, data: data ?? null })
        .catch(e => nativeWarn('sb.bus.publish failed', { topic, error: String(e) }));
      // Local-echo (C1): the native BusBroadcaster skips the sender session
      // (injector/src/ipc/bus.cpp:83), so a same-session subscriber — e.g. the
      // host-bridge purchaseKey delegate and booster-checkout both on Main —
      // would never receive this publish. Deliver to our own local subscribers
      // on a microtask (mirrors the native path's async nature; avoids
      // reentrancy). Native still fans out to the OTHER sessions, so there is
      // no double delivery.
      queueMicrotask(() => deliverLocal(topic, data ?? null));
    },

    subscribe(topic: string, cb: (data: unknown) => void): () => void {
      if (!TOPIC_RE.test(topic))
        throw new Error(`sb.bus.subscribe: invalid topic '${topic}'`);
      if (typeof cb !== 'function')
        throw new TypeError(
          `sb.bus.subscribe: cb must be a function (got ${typeof cb})`);
      let set = subscribers.get(topic);
      if (!set) { set = new Set(); subscribers.set(topic, set); }
      set.add(cb);
      return () => {
        const s = subscribers.get(topic);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) subscribers.delete(topic);
      };
    },
  };
}
