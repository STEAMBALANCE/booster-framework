// One AbortController per injection. Every framework- or plugin-managed
// async resource opts in via the helpers here, so a single rollback call
// cleans them all up. See framework/README.md § "sb.scope" for the
// rationale and full API.
//
// Internal note: the `_abort` method is what makeLifecycleApi calls during
// rollbackAll. We expose it on the public ScopeApi (vs. closing over the
// AbortController) so tests can call it without reaching into closures,
// and so a future "panic-stop" path could call it too.

export interface ScopeApi {
  /** AbortSignal for this injection. Fires on rollbackAll. Pass it to
   *  anything that natively supports `signal` (fetch, addEventListener,
   *  EventSource, ReadableStream, ...). */
  readonly signal: AbortSignal;

  /** Auto-clearing setTimeout. Returns a handle that can be cleared early
   *  via `clearTimeout` or `scope.clearTimeout`. After abort the helper
   *  returns `-1` (a value `clearTimeout` happily accepts as no-op).
   *  Callers should not compare returned ids for equality, only pass them
   *  to clearTimeout. */
  setTimeout(cb: () => void, ms: number): number;

  /** Auto-clearing setInterval. Same `-1`-on-aborted-scope contract as
   *  setTimeout above. */
  setInterval(cb: () => void, ms: number): number;

  /** Pass-through to clearTimeout — handy when most of the call site uses
   *  `sb.scope.*` helpers and the global `clearTimeout` would be the only
   *  scope-leak. Accepts `-1` as a silent no-op. */
  clearTimeout(id: number): void;

  /** Pass-through to clearInterval — see clearTimeout. */
  clearInterval(id: number): void;

  /** addEventListener with auto-removal on abort. The browser does the
   *  removal natively when AbortController is aborted with a `signal`-typed
   *  listener — this helper just removes the boilerplate.
   *
   *  TYPE SAFETY CAVEAT: the `<T extends Event>` generic is purely an
   *  ergonomic narrowing for the handler — there is no static check that
   *  the runtime event for `type` actually matches `T`. Calling
   *  `scope.listen<MessageEvent>(document, 'click', ...)` compiles, but
   *  fires with a real MouseEvent and `ev.data` will be undefined. Same
   *  trust contract as raw `addEventListener` with the DOM-typed
   *  overloads — caller is responsible for matching T to the type string. */
  listen<T extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (ev: T) => void,
    opts?: Omit<AddEventListenerOptions, 'signal'>,
  ): void;

  /** fetch that aborts on rollback. If caller passes their own signal in
   *  init, both signals are merged via AbortSignal.any so EITHER abort
   *  cancels the request. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  /** Wrap a Promise so its downstream `.then` chain bails on abort.
   *  The original operation continues running in the background — abortable
   *  only severs the *subscription* to its result. Use this for legacy or
   *  third-party APIs that don't take a signal. */
  abortable<T>(p: Promise<T>): Promise<T>;

  /** Track a `disconnect`-able observer (MutationObserver,
   *  IntersectionObserver, PerformanceObserver, ...) so it auto-disconnects
   *  on abort. Returns the same observer for chained `.observe(...)`. */
  observer<T extends { disconnect(): void }>(o: T): T;

  /** Internal — aborts the underlying AbortController. Called by
   *  lifecycle.rollbackAll. Also exposed for tests + future panic-stop. */
  _abort(): void;
}

export function createScope(ctrl?: AbortController): ScopeApi {
  const c = ctrl ?? new AbortController();
  const signal = c.signal;

  // Calling scope.* AFTER abort is a usage bug — the contract is "scope
  // is single-use, aborted exactly once at end-of-injection". But the
  // browser's addEventListener spec is explicit: an addEventListener call
  // with an already-aborted signal is a no-op (the listener isn't even
  // registered). That means the abort-cleanup we attach at the bottom of
  // each helper would silently fail to register if scope is already
  // aborted, leaving the underlying setInterval / observer / etc. running
  // forever. The early-outs below turn that quiet leak into a no-op so
  // post-abort calls cost nothing.

  return {
    signal,

    setTimeout(cb, ms) {
      if (signal.aborted) return -1;
      const id = window.setTimeout(cb, ms);
      // { once: true } is critical: the abort signal fires at most once,
      // but multiple addEventListener('abort', ...) without `once` would
      // accumulate references on long-lived AbortSignals. We always pair
      // a signal subscription with `once`.
      signal.addEventListener('abort', () => window.clearTimeout(id), { once: true });
      return id;
    },

    setInterval(cb, ms) {
      if (signal.aborted) return -1;
      const id = window.setInterval(cb, ms);
      signal.addEventListener('abort', () => window.clearInterval(id), { once: true });
      return id;
    },

    clearTimeout(id) {
      // window.clearTimeout silently no-ops on -1 / unknown handles, so we
      // don't need to guard against post-abort sentinel values here.
      window.clearTimeout(id);
    },

    clearInterval(id) {
      window.clearInterval(id);
    },

    listen(target, type, handler, opts) {
      // Cast through EventListener: the public generic gives the caller
      // type-safe access to MessageEvent / KeyboardEvent / etc. while the
      // underlying addEventListener expects the loose EventListener shape.
      // (If signal is already aborted, addEventListener itself no-ops per
      // spec, so no extra guard is needed here.)
      target.addEventListener(
        type,
        handler as EventListener,
        { ...opts, signal },
      );
    },

    fetch(input, init) {
      // Compose user-provided signal with our scope signal so EITHER aborts.
      // AbortSignal.any is supported in CEF/Chromium 124+; Steam runs CEF
      // 126+. If older Chromium support is ever needed, swap for a manual
      // listener-merge helper.
      // (If our signal is already aborted, fetch itself rejects immediately
      // — no extra guard needed.)
      const userSignal = init?.signal;
      const composedSignal = userSignal
        ? AbortSignal.any([userSignal, signal])
        : signal;
      return fetch(input, { ...init, signal: composedSignal });
    },

    abortable<T>(p: Promise<T>): Promise<T> {
      // Fast path: if scope is already aborted, no point waiting on `p` —
      // synchronously reject. Avoids a pointless microtask AND avoids the
      // addEventListener-on-aborted-signal leak (the abort-listener inside
      // Promise.race would never fire, the race would hang indefinitely
      // on the scope side, and the only resolution path would be `p`
      // resolving — defeating the abort guarantee).
      if (signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      return Promise.race([
        p,
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
      ]);
    },

    observer<T extends { disconnect(): void }>(o: T): T {
      if (signal.aborted) {
        // Caller is about to .observe(...) on a dead scope — disconnect it
        // ourselves so the observer doesn't run forever after .observe.
        try { o.disconnect(); } catch { /* swallow */ }
        return o;
      }
      signal.addEventListener(
        'abort',
        () => {
          try {
            o.disconnect();
          } catch {
            // Observer may already be disconnected (caller did it explicitly,
            // or a prior abort fired) — swallow.
          }
        },
        { once: true },
      );
      return o;
    },

    _abort() {
      c.abort();
    },
  };
}
