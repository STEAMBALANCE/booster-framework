// sb.pages — URL-matched page router.
//
// Single source of truth for "this plugin's feature is active while the URL
// matches X". On registration we eagerly reconcile against the current URL;
// on every context.onUrlChange tick we reconcile again. Each registration
// is keyed by `name` (diagnostic-only — used for duplicate guard + warn
// logs). The router owns per-registration mount lifecycle:
//
//   - matched & !active   → invoke mount(ctx); async returns settle into
//                           `cleanup`. If URL leaves match while mount is
//                           in flight, we still wait for the promise to
//                           settle, then unmount (settle-then-unmount).
//                           This is the safer ordering: plugin code that
//                           sets up DOM during async mount mustn't have its
//                           cleanup skipped because reconcile beat it.
//   - !matched & active   → await any pending mount, then run cleanup.
//   - matched & active    → no-op (do NOT re-mount on /foo/a → /foo/b).
//
// scope abort cascades through to every active cleanup; the per-mount
// AbortController inside `PageContext.signal` also fires on individual
// unmounts so mount code can hook fetch/listen to its own signal.
//
// The `reconciling` re-entrancy guard prevents a synchronous mount that
// itself triggers a URL change (history.replaceState in mount body) from
// recursing into reconcile mid-iteration. We pair it with a `reconcileDirty`
// flag so URL changes that fire DURING the await inside `unmountIfActive`
// don't get silently dropped: any concurrent reconcile request sets the
// dirty bit, and the outer reconcile loops once more before clearing the
// guard. Without this, a /foo → /bar → /foo flip during an awaited
// unmount would tear down the registration while the URL once again
// matches the page (registration stuck unmounted until the next URL change).

import type { PagesApi, PageMatch, PageContext, PageHandle, SbContextApi } from './api-types';
import type { ScopeApi } from './scope';
import { nativeWarn } from '../native-warn';

interface Registration {
  match: PageMatch;
  mount: (ctx: PageContext) => void | (() => void) | Promise<void | (() => void)>;
  mountedAt?: {
    url: string;
    ac: AbortController;
    cleanup?: () => void;
    pending?: Promise<void>;
  };
}

function isMatch(m: PageMatch, urlStr: string): boolean {
  if (m.url instanceof RegExp) return m.url.test(urlStr);
  try { return m.url(new URL(urlStr)); }
  catch { return false; }
}

export function makePagesApi(
  scope: ScopeApi,
  context: SbContextApi,
): PagesApi {
  const registrations = new Map<string, Registration>();
  let reconciling = false;
  let reconcileDirty = false;

  async function unmountIfActive(reg: Registration): Promise<void> {
    if (!reg.mountedAt) return;
    const cur = reg.mountedAt;
    reg.mountedAt = undefined;
    if (cur.pending) {
      // Settle-then-unmount: a still-running async mount must finish (and
      // store its cleanup on `cur` itself — NOT on reg.mountedAt, which we
      // just cleared) before we tear down. The success-then below writes
      // directly to its captured `mountedAt` object so this still works.
      try { await cur.pending; } catch { /* mount failure already logged */ }
    }
    cur.ac.abort();
    try { cur.cleanup?.(); }
    catch (e) { nativeWarn('sb.pages cleanup threw', { error: String(e) }); }
  }

  async function reconcile(): Promise<void> {
    if (reconciling) { reconcileDirty = true; return; }
    reconciling = true;
    try {
      do {
        reconcileDirty = false;
        for (const [name, reg] of registrations) {
          const url = context.url;
          const matched = isMatch(reg.match, url);
          const active = !!reg.mountedAt;
          if (matched && !active) {
            const ac = new AbortController();
            // ctx.signal aborts on EITHER per-mount unmount (ac.abort) OR
            // scope rollback (scope.signal). AbortSignal.any composes both
            // without leaking a listener on scope.signal for each mount
            // cycle (the spec uses dependent-signal infra under the hood).
            const ctx: PageContext = {
              url: new URL(url),
              signal: AbortSignal.any([ac.signal, scope.signal]),
            };
            // Build the mountedAt record up front; we mutate `mountedAt.cleanup`
            // from the success-then below. Crucially, the success-then writes
            // to this captured object — NOT to reg.mountedAt — so cleanup
            // survives even if a concurrent unmountIfActive has already
            // detached reg.mountedAt and is awaiting pending.
            const mountedAt: NonNullable<Registration['mountedAt']> = {
              url, ac, pending: undefined,
            };
            let mountResult: ReturnType<Registration['mount']>;
            try { mountResult = reg.mount(ctx); }
            catch (e) { mountResult = Promise.reject(e); }
            mountedAt.pending = Promise.resolve(mountResult).then(
              (cleanup) => {
                mountedAt.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
                mountedAt.pending = undefined;
                // If URL changed away while mount was in flight AND nobody
                // has scheduled an unmount yet (reg.mountedAt still points
                // at us), tear down ourselves. If a concurrent unmountIfActive
                // already detached us, it's awaiting `pending` and will run
                // cleanup as soon as this then-handler completes.
                if (reg.mountedAt === mountedAt
                    && !isMatch(reg.match, context.url)) {
                  void unmountIfActive(reg);
                }
              },
              (err) => {
                nativeWarn(`sb.pages mount '${name}' threw`, { error: String(err) });
                if (reg.mountedAt === mountedAt) {
                  reg.mountedAt = undefined;
                }
                ac.abort();
              },
            );
            reg.mountedAt = mountedAt;
          } else if (!matched && active) {
            await unmountIfActive(reg);
          }
        }
      } while (reconcileDirty);
    } finally {
      reconciling = false;
    }
  }

  context.onUrlChange(() => { void reconcile(); });

  scope.signal.addEventListener('abort', () => {
    for (const reg of registrations.values()) {
      void unmountIfActive(reg);
    }
    registrations.clear();
  }, { once: true });

  return {
    register(opts): PageHandle {
      if (registrations.has(opts.name)) {
        throw new Error(`sb.pages.register: duplicate name '${opts.name}'`);
      }
      registrations.set(opts.name, { match: opts.match, mount: opts.mount });
      void reconcile();
      return {
        unregister: () => {
          const reg = registrations.get(opts.name);
          if (!reg) return;
          // Delete immediately so a same-name re-register can succeed
          // synchronously without racing the async unmount.
          registrations.delete(opts.name);
          void unmountIfActive(reg);
        },
      };
    },
  };
}
