import type { AppApi } from './api/api-types';

export interface PrefetchSetupIdOptions {
  /** Max getSetupId attempts before giving up. Default 20. */
  maxAttempts?: number;
  /** Backoff before attempt n+1 (n is 1-based attempt count). Default
   *  capped ramp. Tests inject `() => 0`. */
  backoffMs?: (attempt: number) => number;
}

// Best-effort, non-blocking: stash the install UUID on a window global at
// bootstrap so the (synchronous) plugin getBoosterHeaders can attach
// x-booster-uuid without an async hop.
//
// Retry until a non-empty value lands: on cold start the SetupId can be
// momentarily unavailable (registry read lag / first-launch write race), and
// a single missed attempt would leave x-booster-uuid empty for the whole
// session. Bounded so a genuinely-absent SetupId can't loop forever. A
// miss/error simply leaves the global unset.
export function prefetchSetupId(
  app: Pick<AppApi, 'getSetupId'>,
  win: { __SB_BOOSTER_UUID__?: string },
  opts: PrefetchSetupIdOptions = {},
): void {
  const maxAttempts = opts.maxAttempts ?? 20;
  const backoffMs = opts.backoffMs ?? ((n) => Math.min(2000, 250 * n));
  let attempt = 0;

  const tryOnce = (): void => {
    attempt += 1;
    void app.getSetupId().then((id) => {
      if (id && !/[\r\n]/.test(id)) { win.__SB_BOOSTER_UUID__ = id; return; }
      if (attempt < maxAttempts) setTimeout(tryOnce, backoffMs(attempt));
    }).catch(() => {
      if (attempt < maxAttempts) setTimeout(tryOnce, backoffMs(attempt));
    });
  };

  tryOnce();
}
