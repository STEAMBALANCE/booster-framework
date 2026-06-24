import { nativeWarn } from '../native-warn';
import {
  buildAttachPopupFlags,
  buildOpenWindowFlags,
  type AttachPopupFlagOpts,
  type OpenWindowFlagOpts,
} from './popup-flags';
import { commonPopupSetup, removeTrackedZombies, destroyPopup } from './popup-lifecycle';
import type {
  SteamPopupInstance,
  SteamPopupWindow,
  SteamPopupParams,
  SteamPopupConstructor,
} from './popup-types';
import { composeWrapperHtml } from './window-wrapper';

interface PopupTemplate {
  Ctor: SteamPopupConstructor;
  baseParams: Pick<SteamPopupParams, 'html_class' | 'popup_class' | 'target_browser' | 'window_opener_id'>;
}

function getPopupTemplate(): PopupTemplate | null {
  const pm = (window as unknown as { g_PopupManager?: { m_mapPopups?: Map<string, SteamPopupInstance> } }).g_PopupManager;
  if (!pm?.m_mapPopups) return null;
  let cm: SteamPopupInstance | undefined = pm.m_mapPopups.get('contextmenu_1_uid0');
  if (!cm) {
    for (const [key, value] of pm.m_mapPopups) {
      if (/^contextmenu_\d+_uid0$/.test(key)) { cm = value; break; }
    }
  }
  if (!cm?.m_rgParams || !cm.constructor) return null;
  return { Ctor: cm.constructor as unknown as SteamPopupConstructor, baseParams: cm.m_rgParams };
}

/** Read the main-shell window's screen-coords + dimensions from
 *  g_PopupManager (Steam tracks the main browser as `SP Desktop_uid0`).
 *  Returns null if the main shell isn't tracked (early-boot edge or a
 *  Steam internal change). */
interface MainShellRect { x: number; y: number; w: number; h: number; dpr: number; }
function getMainShellRect(): MainShellRect | null {
  const pm = (window as unknown as {
    g_PopupManager?: { m_mapPopups?: Map<string, SteamPopupInstance> };
  }).g_PopupManager;
  const main = pm?.m_mapPopups?.get('SP Desktop_uid0')?.m_popup;
  if (!main) return null;
  type MainWin = SteamPopupWindow & {
    screenX?: number; screenY?: number;
    outerWidth?: number; outerHeight?: number;
    devicePixelRatio?: number;
  };
  const mw = main as MainWin;
  const x = typeof mw.screenX === 'number' ? mw.screenX : 0;
  const y = typeof mw.screenY === 'number' ? mw.screenY : 0;
  const w = typeof mw.outerWidth  === 'number' ? mw.outerWidth  : 0;
  const h = typeof mw.outerHeight === 'number' ? mw.outerHeight : 0;
  const dpr = typeof mw.devicePixelRatio === 'number' && mw.devicePixelRatio > 0 ? mw.devicePixelRatio : 1;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h, dpr };
}

interface CreateChromelessPopupArgs {
  popupId: string;
  html: string;
  width: number;
  height: number;
  flagOpts: AttachPopupFlagOpts;
}

export function createChromelessPopup(args: CreateChromelessPopupArgs):
  { popup: SteamPopupInstance; popupWin: SteamPopupWindow } | null {

  const tpl = getPopupTemplate();
  if (!tpl) return null;
  removeTrackedZombies(args.popupId);

  const eCreationFlags = buildAttachPopupFlags(args.flagOpts);

  const params = {
    html_class:               tpl.baseParams.html_class,
    body_class:               'sb_topup_body',
    popup_class:              tpl.baseParams.popup_class,
    replace_existing_popup:   true,
    target_browser:           tpl.baseParams.target_browser,
    window_opener_id:         tpl.baseParams.window_opener_id,
    bHideOnClose:             true,
    eCreationFlags,
    dimensions: { left: 0, top: 0, width: args.width, height: args.height },
  };

  let popup: SteamPopupInstance;
  try {
    popup = new tpl.Ctor(args.popupId, params, () => {});
  } catch (e) {
    nativeWarn('createChromelessPopup: ctor threw', { error: String(e) });
    return null;
  }

  try { popup.Show(); }
  catch (e) {
    nativeWarn('createChromelessPopup: Show threw', { error: String(e) });
    return null;
  }

  const popupWin = commonPopupSetup({
    popup,
    popupId: args.popupId,
    content: { kind: 'html', html: args.html },
    hideOnClose: true,
  });
  if (!popupWin) {
    destroyPopup(popup);
    return null;
  }

  return { popup, popupWin };
}

interface CreateSteamWindowArgs {
  windowId: string;
  title: string;
  content: { kind: 'url'; url: string } | { kind: 'html'; html: string };
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  flagOpts: OpenWindowFlagOpts;
  centerOnMain: boolean;
  iframeBackground?: string;
  embedOrigins?: string[];
}

export function createSteamWindow(args: CreateSteamWindowArgs):
  { popup: SteamPopupInstance; popupWin: SteamPopupWindow } | null {

  const tpl = getPopupTemplate();
  if (!tpl) return null;
  // Caller (relay handler) проверяет id-collision через idTaken();
  // см. window-handlers.ts. removeTrackedZombies безопасен только для
  // dead-but-tracked entries; live entry защищён через idTaken.
  removeTrackedZombies(args.windowId);

  const eCreationFlags = buildOpenWindowFlags(args.flagOpts);
  const wrapperHtml = composeWrapperHtml({
    windowId: args.windowId,
    title:    args.title,
    content:  args.content,
    iframeBackground: args.iframeBackground,
    embedOrigins: args.embedOrigins,
  });

  // Compute centered position UPFRONT so the popup opens already-centered
  // (no flicker / no MoveTo race against Steam's realize cycle). Steam
  // reads `dimensions.left/top` in main-shell coord space, scaled by the
  // main shell's devicePixelRatio. When getMainShellRect returns valid
  // data we put the window dead-center on main shell. Falls back to (0,0)
  // when main shell isn't tracked yet (early-boot edge — rare).
  const mainRect = args.centerOnMain ? getMainShellRect() : null;
  const initialLeft = mainRect
    ? mainRect.x + Math.round((mainRect.w - args.width)  / 2)
    : 0;
  const initialTop = mainRect
    ? mainRect.y + Math.round((mainRect.h - args.height) / 2)
    : 0;

  // Match Steam's "Новости обновлений" modal params byte-for-byte to
  // get its CSS-driven modal chrome AND avoid Windows DWM restore-from-
  // taskbar animation (Steam's modals don't have it; bare flags=2
  // alone wasn't enough — verified live 2026-05-07). The HTML / body /
  // popup class trio activates Steam's React `ModalDialogPopup` CSS in
  // the popup window, which apparently includes whatever frontend
  // hint suppresses the OS show animation. We don't render Steam's
  // React components inside (we document.write our own wrapper), but
  // the styles still apply to the body + html elements.
  const params: SteamPopupParams = {
    html_class:               'client_chat_frame fullheight ModalDialogPopup',
    body_class:               'fullheight ModalDialogBody DesktopUI',
    popup_class:              'fullheight',
    replace_existing_popup:   true,
    target_browser:           tpl.baseParams.target_browser,
    window_opener_id:         tpl.baseParams.window_opener_id,
    bHideOnClose:             false,
    eCreationFlags,
    dimensions: { left: initialLeft, top: initialTop, width: args.width, height: args.height },
    minWidth: args.minWidth,
    minHeight: args.minHeight,
    ...(args.centerOnMain ? { center_on_window: tpl.baseParams.target_browser } : {}),
  };

  let popup: SteamPopupInstance;
  try {
    popup = new tpl.Ctor(args.windowId, params, () => {});
  } catch (e) {
    nativeWarn('createSteamWindow: ctor threw', { error: String(e) });
    return null;
  }

  try { popup.Show(); }
  catch (e) {
    nativeWarn('createSteamWindow: Show threw', { error: String(e) });
    return null;
  }

  const popupWin = commonPopupSetup({
    popup,
    popupId: args.windowId,
    content: { kind: 'html', html: wrapperHtml },
    hideOnClose: false,
    // openWindow modals (flags=3) get stuck "hidden" if we run the
    // dropdown warmup — Steam's PopupClass.Show() already realizes them.
    skipWarmup: true,
  });
  if (!popupWin) {
    destroyPopup(popup);
    return null;
  }

  try { popupWin.SteamClient?.Window?.SetMinSize?.(args.minWidth, args.minHeight); } catch {}

  // Raise + focus. Position is already correct via dimensions.left/top
  // computed from getMainShellRect above; popup.Show() above already
  // showed the OS window. We DON'T call ShowWindow() here — Steam's
  // PopupClass.Show() has already realized the window, and a redundant
  // OS ShowWindow triggers Windows' "restore-from-taskbar" animation
  // (window slides up from the taskbar icon), which Steam's own modals
  // don't have. BringToFront + SetKeyFocus alone bring the window
  // forward without any animation.
  const sw = popupWin.SteamClient?.Window;
  try { sw?.BringToFront?.(); } catch {}
  try { sw?.SetKeyFocus?.(true); } catch {}

  return { popup, popupWin };
}
