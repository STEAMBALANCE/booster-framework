// Relay-side openWindow handlers. Owns the per-window lifecycle from
// open-window through close-event, mirrors framework-side ui.ts validation
// (defense-in-depth: framework + relay live in different JS realms; a
// malicious or buggy framework instance could bypass ui.ts by posting
// straight to BC), and runs a 250ms BIsClosed poll to detect the window
// going away — whether by caller action, user X-click, or external crash.
//
// Pre-emptively split out of shared-context.ts so the relay module stays
// under the 600-LOC soft cap. Wired in via shared-context.startRelay.

import { POPUP_ID_RE, OPEN_WINDOW_HTML_MAX_BYTES } from './protocol';
import type {
  OpenWindowRequest, OpenWindowResponse,
  WindowShowRequest, WindowHideRequest, WindowCloseRequest,
  WindowBringRequest, WindowPostMessageRequest, WindowUserCloseEvent,
  WindowCloseEvent,
} from './protocol';
import { createSteamWindow } from './popup-factory';
import { destroyPopup } from './popup-lifecycle';
import type { SteamPopupInstance, SteamPopupWindow } from './popup-types';
import type { RelayAuthToken } from './auth';

// Width/height clamps — caller-supplied values outside [200..2000] x
// [150..1500] get squished into range. Mirror of framework-side ui.ts
// clamping; relay enforces independently so a corrupt main-shell can't
// allocate a 99999×1 native window.
const MIN_WINDOW_W = 200;
const MAX_WINDOW_W = 2000;
const MIN_WINDOW_H = 150;
const MAX_WINDOW_H = 1500;
const MIN_MIN_W = 200;
const MIN_MIN_H = 150;

// Polling cadence for BIsClosed checks. 250ms balances responsiveness
// (close-event fires within ~quarter-second of the window dying) against
// CPU cost (one bool check per quarter-second per open window — trivial).
const CLOSE_POLL_MS = 250;

export interface WindowTracking {
  popup: SteamPopupInstance;
  popupWin: SteamPopupWindow;
  pollHandle: number;
  /** Режим контента — url-окна доставляются обёрткой, не relay. */
  contentMode: 'url' | 'html';
  /** Set by handleClose ('caller') or handleUserClose ('user') BEFORE the
   *  poll observes BIsClosed=true. The polling tick reads it to decide
   *  the close-event reason; absence means 'crash' (external death). */
  lastReason?: 'caller' | 'user';
}

export interface ScopeLike {
  readonly signal: AbortSignal;
  setInterval(cb: () => void, ms: number): number;
  clearInterval(id: number): void;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Same allow-list as framework-side ui.ts: https only, no userinfo, no
 *  port, ASCII-only (no IDN homograph attacks). Tested on the framework
 *  side too — duplicated here as the second, independent gate. */
function isUrlSafe(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.port) return false;
  if (/[^\x20-\x7E]/.test(url)) return false;
  return true;
}

/** Validates an embedOrigins entry: https only, ASCII only, no userinfo,
 *  no non-default port, exact origin match (no path/query). */
export function isOriginSafe(o: string): boolean {
  if (!/^https:\/\//.test(o)) return false;
  if (/[^\x21-\x7E]/.test(o)) return false;
  let u: URL;
  try { u = new URL(o); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.port) return false;
  return u.origin === o;
}
const MAX_EMBED_ORIGINS = 8;

export function sanitizeEmbedOrigins(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((o): o is string => typeof o === 'string' && isOriginSafe(o))
    .slice(0, MAX_EMBED_ORIGINS);
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function makeWindowHandlers(args: {
  bc: BroadcastChannel;
  scope: ScopeLike;
  popups: Map<string, unknown>;
  windows: Map<string, WindowTracking>;
  relayAuthToken?: RelayAuthToken;
}) {
  const { bc, scope, popups, windows, relayAuthToken } = args;

  // Defense-in-depth: an id is "taken" if EITHER an active attachPopup
  // OR another open-window already owns it. Matches the framework-side
  // single-namespace contract documented in ui.ts.
  function idTaken(id: string): boolean {
    return popups.has(id) || windows.has(id);
  }

  function emitCloseEvent(windowId: string, reason: WindowCloseEvent['reason']): void {
    bc.postMessage({ kind: 'window-close-event', windowId, reason });
  }

  function armCloseDetection(popup: SteamPopupInstance, windowId: string): number {
    // Two close-detection paths checked together: Steam's own
    // popup.BIsClosed() and the underlying CEF window's `closed` flag.
    // They can disagree — an externally-killed CEF window flips
    // m_popup.closed to true without going through Steam's Close path,
    // so BIsClosed stays false. Trust the OR.
    const handle = scope.setInterval(() => {
      if (popup.BIsClosed?.() === true || popup.m_popup?.closed) {
        const tracked = windows.get(windowId);
        scope.clearInterval(handle);
        if (!tracked) return;
        const reason = tracked.lastReason ?? 'crash';
        windows.delete(windowId);
        emitCloseEvent(windowId, reason);
      }
    }, CLOSE_POLL_MS);
    return handle;
  }

  function rejectOpen(req: OpenWindowRequest, error: string): void {
    const resp: OpenWindowResponse = {
      kind: 'window-open-error',
      requestId: req.requestId,
      windowId: req.windowId,
      error,
    };
    bc.postMessage(resp);
  }

  function handleOpenWindow(req: OpenWindowRequest): void {
    if (!POPUP_ID_RE.test(req.windowId)) return rejectOpen(req, 'invalid id');
    if (idTaken(req.windowId))           return rejectOpen(req, 'id collides with another popup or window');

    const hasUrl  = typeof req.url  === 'string' && req.url.length  > 0;
    const hasHtml = typeof req.html === 'string' && req.html.length > 0;
    if (hasUrl && hasHtml) return rejectOpen(req, 'url and html are mutually exclusive');
    if (!hasUrl && !hasHtml) return rejectOpen(req, 'either url or html is required');

    if (typeof req.title !== 'string' || req.title.length === 0)
      return rejectOpen(req, 'title is required');

    if (hasUrl && !isUrlSafe(req.url!)) return rejectOpen(req, 'unsafe url');
    if (hasHtml && utf8ByteLength(req.html!) > OPEN_WINDOW_HTML_MAX_BYTES)
      return rejectOpen(req, 'html too large');

    const w  = clamp(req.width  | 0, MIN_WINDOW_W, MAX_WINDOW_W);
    const h  = clamp(req.height | 0, MIN_WINDOW_H, MAX_WINDOW_H);
    const mw = Math.max(MIN_MIN_W, (req.minWidth  | 0) || 320);
    const mh = Math.max(MIN_MIN_H, (req.minHeight | 0) || 240);

    const embedOrigins = sanitizeEmbedOrigins(req.embedOrigins);

    const created = createSteamWindow({
      windowId: req.windowId,
      title:    req.title,
      content:  hasUrl ? { kind: 'url',  url:  req.url!  } : { kind: 'html', html: req.html! },
      width: w, height: h, minWidth: mw, minHeight: mh,
      flagOpts: {
        resizable:     req.resizable,
        noTaskbarIcon: req.noTaskbarIcon,
        alwaysOnTop:   req.alwaysOnTop,
        composited:    req.composited,
      },
      centerOnMain: req.centerOnMain,
      iframeBackground: req.iframeBackground,
      embedOrigins,
      relayAuthToken,
    });

    if (!created) return rejectOpen(req, 'createSteamWindow returned null');

    const pollHandle = armCloseDetection(created.popup, req.windowId);
    windows.set(req.windowId, {
      popup: created.popup,
      popupWin: created.popupWin,
      pollHandle,
      contentMode: hasUrl ? 'url' : 'html',
    });

    const resp: OpenWindowResponse = {
      kind: 'window-opened',
      requestId: req.requestId,
      windowId:  req.windowId,
      effectiveWidth: w,
      effectiveHeight: h,
    };
    bc.postMessage(resp);
  }

  function handleShow(msg: WindowShowRequest): void {
    const t = windows.get(msg.windowId); if (!t) return;
    try { t.popupWin.SteamClient?.Window?.ShowWindow?.(); } catch {}
    bc.postMessage({ kind: 'window-show-event', windowId: msg.windowId });
  }

  function handleHide(msg: WindowHideRequest): void {
    const t = windows.get(msg.windowId); if (!t) return;
    try { t.popupWin.SteamClient?.Window?.HideWindow?.(); } catch {}
    bc.postMessage({ kind: 'window-hide-event', windowId: msg.windowId });
  }

  function handleBring(msg: WindowBringRequest): void {
    const t = windows.get(msg.windowId); if (!t) return;
    try { t.popupWin.SteamClient?.Window?.BringToFront?.(); } catch {}
  }

  /** Eagerly finalize a close: clear poll, drop tracking, emit close-event.
   *  Used by both handleClose ('caller') and handleUserClose ('user') so the
   *  close-event fires on the same BC microtask as the close trigger — NOT
   *  ~CLOSE_POLL_MS later. Without this, callers who store the handle (e.g.
   *  booster-checkout's `supportHandle`) and gate next-action on `handle.on('close')`
   *  see a 0–250 ms window where the handle is stale: a fast re-open click
   *  bringsToFront() a destroyed window and looks like "click did nothing".
   *  Polling stays armed as the crash-detection backstop (BIsClosed=true
   *  without a caller/user signal → reason='crash'). */
  function finalizeClose(windowId: string, reason: 'caller' | 'user'): void {
    const t = windows.get(windowId); if (!t) return;
    if (t.lastReason) return;
    t.lastReason = reason;
    scope.clearInterval(t.pollHandle);
    windows.delete(windowId);
    emitCloseEvent(windowId, reason);
  }

  function handleClose(msg: WindowCloseRequest): void {
    const t = windows.get(msg.windowId); if (!t) return;
    // Race guard: a back-to-back caller-close + user-close (window-close
    // arrives via BC, user clicks X immediately after) must produce ONE
    // close-event with the FIRST reason. finalizeClose's lastReason check
    // covers it.
    if (t.lastReason) return;
    destroyPopup(t.popup, t.popupWin);
    finalizeClose(msg.windowId, 'caller');
  }

  function handleUserClose(msg: WindowUserCloseEvent): void {
    // Don't call destroyPopup — wrapper iframe already invoked
    // SteamClient.Window.Close() before posting this event; we just need to
    // record the reason and finalize. finalizeClose is no-op'd if a prior
    // caller-close has already marked lastReason.
    finalizeClose(msg.windowId, 'user');
  }

  function handlePostMessage(msg: WindowPostMessageRequest): void {
    const t = windows.get(msg.windowId); if (!t) return;
    // url-окна: доставку cross-origin iframe'у владеет обёртка
    // (window.postMessage). Relay-ре-броадкаст породил бы двойную доставку
    // + само-эхо в on('message') отправителя. html-окна (srcdoc same-origin
    // слушает sb_cmd напрямую) ре-броадкастим как раньше.
    if (t.contentMode === 'url') return;
    bc.postMessage({ kind: 'window-message', windowId: msg.windowId, data: msg.data });
  }

  function teardownAll(): void {
    for (const [windowId, t] of windows) {
      try { destroyPopup(t.popup, t.popupWin); } catch {}
      // Preserve lastReason if set: a caller-close fired just before scope
      // abort must still propagate reason='caller', not 'teardown'.
      emitCloseEvent(windowId, t.lastReason ?? 'teardown');
    }
    windows.clear();
    // Polling handles auto-clear via scope abort (fires after this teardown
    // when shared-context.teardown invokes scope._abort()). Per-window
    // clearInterval here would be redundant.
  }

  scope.signal.addEventListener('abort', teardownAll);

  // Note: spec § 1.2 mentions a `destroyWindow` 3-step helper. We reuse
  // `destroyPopup` since `bHideOnClose:false` was set at create time —
  // the extra `SetHideOnClose(false)` call inside destroyPopup is a
  // no-op for our windows, and reducing helper proliferation keeps the
  // lifecycle code single-pathed. Tests pin the close-event reason
  // values, not the helper-name.

  return {
    handleOpenWindow, handleShow, handleHide, handleBring,
    handleClose, handleUserClose, handlePostMessage, teardownAll,
  };
}
