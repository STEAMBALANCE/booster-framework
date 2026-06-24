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

export function makeBusApi(scope: ScopeApi, bridge: Bridge): BusApi {
  const subscribers = new Map<string, Set<(d: unknown) => void>>();

  // Install dispatch entry-point. C++ broadcasts call this on each target.
  // Use globalThis (not window) — works in main shell + store pages + service
  // contexts. The C++-emitted JS does `window.__sb_bus_dispatch && ...`,
  // which `globalThis === window` makes equivalent in any browser-like context.
  (globalThis as { __sb_bus_dispatch?: (t: string, d: unknown) => void })
    .__sb_bus_dispatch = (topic: string, data: unknown) => {
    const set = subscribers.get(topic);
    if (!set) {
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
