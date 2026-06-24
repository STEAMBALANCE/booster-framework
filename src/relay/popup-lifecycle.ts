import { nativeWarn } from '../native-warn';
import type { SteamPopupInstance, SteamPopupWindow } from './popup-types';

interface CommonPopupSetupArgs {
  popup: SteamPopupInstance;
  popupId: string;
  content: { kind: 'html'; html: string } | { kind: 'url' };
  hideOnClose: boolean;
  /** Skip the ShowWindow + HideWindow CEF warmup. For openWindow modals
   *  (flags=3) the warmup leaves the OS window in a hidden state that
   *  the subsequent ShowWindow doesn't recover; for chromeless dropdowns
   *  (flags=4538634) the warmup is needed to force CEF realize before
   *  first show-with-coords. Default false → warmup runs (legacy
   *  attachPopup behaviour). openWindow passes true. */
  skipWarmup?: boolean;
}

/** Shared post-Show workaround chain — applied to BOTH chromeless and full
 *  windows. Returns popupWin on success; null on failure (caller cleans
 *  up via destroyPopup + posts attach/open error).
 *
 *  Order is load-bearing (tested by relay.test.ts):
 *    1. m_popup unset detection — Show() can fail to populate it.
 *    2. SetHideOnClose — before CEF warmup so the popup isn't accidentally
 *       destroyed by the warmup HideWindow on a Close-becomes-hide path.
 *    3. CEF realize warmup (ShowWindow + HideWindow). HIDDEN bit in
 *       eCreationFlags triggers deferred-realize; one cycle forces full
 *       realization while keeping the popup off-screen at (0,0).
 *    4. rewriteContent — after warmup so the document is in its fully
 *       realized state (covers both fresh creation and adoption). */
export function commonPopupSetup(args: CommonPopupSetupArgs): SteamPopupWindow | null {
  const { popup, popupId, content, hideOnClose, skipWarmup } = args;

  // Step 1: m_popup unset detection.
  const popupWin = popup.m_popup;
  if (!popupWin) {
    nativeWarn('commonPopupSetup: popup.m_popup unset after Show', { popupId });
    return null;
  }

  // Step 2: SetHideOnClose.
  if (hideOnClose) {
    try { popupWin.SteamClient?.Window?.SetHideOnClose?.(true); } catch {}
  }

  // Step 3: CEF realize warmup (skipped for openWindow modals).
  if (!skipWarmup) {
    try { popupWin.SteamClient?.Window?.ShowWindow?.(); } catch {}
    try { popupWin.SteamClient?.Window?.HideWindow?.(); } catch {}
  }

  // Step 4: rewriteContent for html-content.
  if (content.kind === 'html') {
    try {
      popupWin.document.open();
      popupWin.document.write(content.html);
      popupWin.document.close();
    } catch (e) {
      nativeWarn('commonPopupSetup: rewriteContent threw', { popupId, error: String(e) });
      return null;
    }
  }

  return popupWin;
}

/** Drop tracked-but-dead entries under this popupId from g_PopupManager.
 *  Used before fresh creation to clear orphans от previous session. */
export function removeTrackedZombies(popupId: string): void {
  const gpm = (window as unknown as {
    g_PopupManager?: {
      m_mapPopups?: Map<string, { m_strName?: string }>;
      RemoveTrackedPopup?: (p: unknown) => void;
    };
  }).g_PopupManager;
  const map = gpm?.m_mapPopups;
  if (!map || typeof gpm?.RemoveTrackedPopup !== 'function') return;
  const namePrefix = popupId + '_uid';
  const toRemove: unknown[] = [];
  for (const [, entry] of map) {
    const n = entry?.m_strName;
    if (typeof n === 'string' && n.startsWith(namePrefix)) toRemove.push(entry);
  }
  for (const dead of toRemove) {
    try { gpm.RemoveTrackedPopup!(dead); } catch {}
  }
}

/** Four-step popup destruction. Order is load-bearing:
 *  1. RemoveTrackedPopup BEFORE Close — popup.Close() on a bHideOnClose:true
 *     popup short-circuits to hide, leaving the m_mapPopups entry tracked.
 *     RemoveTrackedPopup empirically removes the entry; this unblocks the
 *     next session's attach.
 *  2. SetHideOnClose(false) so the explicit Close() that follows is treated
 *     as a real destroy, not a hide.
 *  3. popup.Close() — Steam's PopupClass close handler.
 *  4. win.close() — DOM Window.close as belt-and-braces against any combination
 *     of close-becomes-hide semantics.
 *  Each try/catch is independent so one step throwing must not skip the others. */
export function destroyPopup(popup: SteamPopupInstance, win?: SteamPopupWindow | null): void {
  try {
    const gpm = (window as unknown as {
      g_PopupManager?: { RemoveTrackedPopup?: (p: unknown) => void };
    }).g_PopupManager;
    gpm?.RemoveTrackedPopup?.(popup);
  } catch {}
  try { win?.SteamClient?.Window?.SetHideOnClose?.(false); } catch {}
  try { popup.Close?.(); } catch {}
  try { win?.close?.(); } catch {}
}
