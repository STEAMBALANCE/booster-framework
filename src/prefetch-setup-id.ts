import type { AppApi } from './api/api-types';

// Best-effort, non-blocking: stash the install UUID on a window global at
// bootstrap so the (synchronous) plugin getBoosterHeaders can attach
// x-booster-uuid without an async hop. A miss/error simply leaves it unset.
export function prefetchSetupId(
  app: Pick<AppApi, 'getSetupId'>,
  win: { __SB_BOOSTER_UUID__?: string },
): void {
  void app.getSetupId().then((id) => {
    if (id && !/[\r\n]/.test(id)) win.__SB_BOOSTER_UUID__ = id;
  }).catch(() => { /* */ });
}
