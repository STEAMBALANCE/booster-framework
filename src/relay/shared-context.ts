import {
  RELAY_CHANNEL,
  POPUP_ID_RE,
  POPUP_HTML_MAX_BYTES,
  type RelayMessage,
  type AttachPopupRequest,
  type PopupShowRequest,
  type PopupHideRequest,
  type PopupToggleRequest,
  type PopupDestroyRequest,
  type PopupPostMessageRequest,
  type NavigateRequest,
} from './protocol';
import type { ScopeApi } from '../api/scope';
import { nativeWarn } from '../native-warn';
import {
  installUserChangeListener as installPushUserChangeListener,
  handleRequestSnapshot,
  handleGetUserAccountSettings,
  handleGetUserCountry,
  handleGetUserLanguage,
} from './user-data';
import { createChromelessPopup } from './popup-factory';
import { destroyPopup } from './popup-lifecycle';
import type { SteamPopupParams } from './popup-types';
import { makeWindowHandlers, type WindowTracking } from './window-handlers';
import { setupExternalWindowRelay, teardownExternalWindowRelay } from './external-window';
import { createBridge, hideNativeBridgeGlobal } from '../bridge';
import { handleActivateProductKey } from './key-activation';
import { handleGetMachineId } from './machine-id';
import { isUrlSafeForNavigation, safeHostForLog } from '../navigation-safety';
import { hasValidRelayAuth, readRelayAuthToken } from './auth';

declare global {
  interface SteamClientShape {
    User?: {
      GetLoginUsers?: () => Promise<Array<{
        accountName: string;
        personaName?: string;
        avatarUrl?: string;
        rememberPassword?: boolean;
        hasPin?: boolean;
      }>>;
      GetIPCountry?: () => Promise<string>;
      RegisterForCurrentUserChanges?: (
        cb: (info: {
          strAccountName?: string;
          strSteamID?: string;
          strFamilyGroupID?: string;
          strAccountBalance?: string;
          strAccountBalancePending?: string;
          strClientInstanceID?: string;
          bIsLimited?: boolean;
          bIsOfflineMode?: boolean;
          bSupportAlertActive?: boolean;
          bSupportPopupMessage?: boolean;
          bSupportAckOnlyMessages?: boolean;
          bPromptToChangePassword?: boolean;
          bHWSurveyPending?: boolean;
          NotificationCounts?: Record<string, number>;
        }) => void,
      ) => { unregister: () => void } | undefined;
      // ↑ may return undefined on early-boot; spec handles via reg?.unregister
    };
    Settings?: {
      GetAccountSettings?: () => Promise<{
        strEmail?: string;
        bEmailValidated?: boolean;
        bHasAnyVACBans?: boolean;
        bHasTwoFactor?: boolean;
        eSteamGuardState?: number;
        rtSteamGuardEnableTime?: number;
        bSaveAccountCredentials?: boolean;
      }>;
      GetCurrentLanguage?: () => Promise<string>;
    };
    SharedConnection?: {
      AllocateSharedConnection?: () => Promise<number>;
      SendMsgAndAwaitBinaryResponse?: (handle: number, msgBase64: string) => Promise<ArrayBuffer | Uint8Array>;
      Close?: (handle: number) => void;
    };
  }
  interface Window {
    SteamClient?: SteamClientShape;
    MainWindowBrowserManager?: { LoadURL: (url: string) => void; m_tabbedBrowserStore?: any };
    g_PopupManager?: SteamPopupManager;
    __sb_relay_started?: boolean;
    __sb_relay_teardown?: () => void;
  }
}

// SteamPopupParams shape — eCreationFlags computed by popup-factory.ts via
// buildAttachPopupFlags (default STEAM_DROPDOWN_FLAGS = 4538634).
// Imported from popup-types.ts — shared across relay modules.

interface PopupSteamWindow {
  Window?: {
    SetHideOnClose?: (on: boolean) => void;
    HideWindow?: () => void;
    ShowWindow?: () => void;
    BringToFront?: () => void;
    MoveTo?: (x: number, y: number, scale?: number) => void;
    ResizeTo?: (w: number, h: number, scale?: number) => void;
    SetKeyFocus?: (on: boolean) => void;
    Close?: () => void;
  };
}

type SteamPopupWindow = Window & {
  SteamClient?: PopupSteamWindow;
  document: Document;
  closed: boolean;
};

// Shape of one entry in `g_PopupManager.m_mapPopups`. Steam's actual class is
// minified `m extends i.Ad` — we type the slots we touch and leave the rest
// implicit. `m_callbacks` is the recipe for hooking onCreate / etc. without
// React; `Show()` triggers Steam's internal `T.CreatePopup` which allocates
// the native CEF popup and assigns `m_popup`.
interface SteamPopupInstance {
  m_popup?: SteamPopupWindow | null;
  m_bCreated?: boolean;
  m_callbacks?: {
    onCreate?: (popupWin: SteamPopupWindow, element: unknown) => void;
    updateParamsBeforeShow?: (params: SteamPopupParams) => SteamPopupParams;
  };
  Show: (mode?: number | boolean) => void;
  Close?: () => void;
  BIsVisible?: () => boolean;
  BIsClosed?: () => boolean;
}

interface SteamPopupManager {
  m_mapPopups: Map<string, SteamPopupInstance>;
}

interface PopupEntry {
  popup: SteamPopupInstance;
  win: SteamPopupWindow;
  visible: boolean;
  width: number;
  height: number;
  hideOnBlur: boolean;
  // Handle returned by scope.setInterval — kept here so handlePopupDestroy
  // (and the reuse-path failure branch) can stop the poll BEFORE scope
  // abort. On scope abort, the scope's own cleanup also clears it
  // (idempotent — clearInterval on a stale handle is safe).
  blurPollHandle: number | null;
  // Wall-clock-ish (perf.now()) of the last show or hide. Read by
  // handlePopupToggle to enforce SB_POPUP_GATE_MS — relay-side debounce
  // that consumes rapid second toggles without acting on them.
  lastStateChangeAt: number;
}

// 150ms matches Steam's own dropdown dismiss responsiveness — fast enough that
// outside-click feels instant, slow enough that the poll itself is invisible
// in CPU usage. Set against the popup's own document.hasFocus() (NOT the
// SharedJSContext document, which would always test true).
const BLUR_POLL_MS = 150;

declare const __SB_PRODUCTION__: boolean;

/** Toggle gate window in ms. Defaults to 250 (Steam-native dropdown
 *  responsiveness). `SB_POPUP_GATE_MS=0` disables the gate (used in
 *  bun tests with deterministic performance.now mocks). */
function getGateMs(): number {
  if (typeof __SB_PRODUCTION__ !== 'undefined' && __SB_PRODUCTION__) return 250;
  if (typeof process === 'undefined') return 250;
  const raw = process.env['SB_POPUP_GATE_MS'];
  if (raw === undefined || raw === '') return 250;
  const env = Number(raw);
  return Number.isFinite(env) && env >= 0 ? env : 250;
}

/** Returns a teardown function that aborts the scope, destroys outstanding
 *  popups, closes the relay channel and clears the per-Window guard.
 *  Idempotent — calling twice is a no-op.
 *
 *  `scope` is owned by the caller (bootstrap creates it). On teardown the
 *  scope is `_abort()`-ed; this is what removes the BC listener, clears
 *  blur-poll setInterval'ы, and cancels any other scope-tracked async. */
export function startRelay(scope: ScopeApi): () => void {
  if (window.__sb_relay_started) return () => {};
  window.__sb_relay_started = true;

  // Initial teardown placeholder — installed BEFORE any code below that
  // could throw (MWBM access, etc). Without this, a
  // throw between `__sb_relay_started = true` and the final teardown
  // assignment would leave `__sb_relay_started=true` with no teardown
  // function on `window`, so the next bootstrap couldn't tear down
  // orphan resources. The closure variables (`bc`, `popups`, `scope`)
  // are captured by reference — the placeholder reads whatever's been
  // set up so far and performs best-effort cleanup. Replaced at the
  // bottom of this function with the full teardown once construction
  // succeeds.
  const initialTeardown = (): void => {
    try { scope._abort(); } catch { /* swallow */ }
    window.__sb_relay_started = false;
    if (window.__sb_relay_teardown === initialTeardown) {
      window.__sb_relay_teardown = undefined;
    }
  };
  window.__sb_relay_teardown = initialTeardown;

  const bc = new BroadcastChannel(RELAY_CHANNEL);
  const relayAuthToken = readRelayAuthToken();
  // Singleton map keyed by popupId. Re-attach with the same id reuses the
  // existing native window — refusing to allocate a second native popup is
  // the *whole point* of the attach-once / toggle-many model. Spawning a
  // new popup per attach quickly accumulates orphan native windows on rapid
  // steambooster restarts (we shipped 11 of them before this fix landed).
  const popups = new Map<string, PopupEntry>();
  // Per-window tracking — shared with makeWindowHandlers so attach-popup's
  // idTaken can also see open windows (single-namespace: one id at a time).
  const windows = new Map<string, WindowTracking>();
  const winHandlers = makeWindowHandlers({ bc, scope, popups, windows, relayAuthToken });
  // Set when teardown begins so a microtask-deferred attach (see
  // handleAttachPopup) skips its setup if the relay is being torn down.
  // Without this, an attach in flight at teardown time would create an
  // orphan Steam popup that's never closed (no entry in `popups`).
  let tornDown = false;

  scope.listen<MessageEvent>(bc, 'message', (ev) => {
    const msg = ev.data as RelayMessage;
    if (!msg || typeof msg !== 'object') return;
    if (!hasValidRelayAuth(msg, relayAuthToken)) return;
    switch (msg.kind) {
      case 'attach-popup':
        handleAttachPopup(msg);
        break;
      case 'popup-show':
        handlePopupShow(msg);
        break;
      case 'popup-hide':
        handlePopupHide(msg);
        break;
      case 'popup-toggle':
        handlePopupToggle(msg);
        break;
      case 'popup-destroy':
        handlePopupDestroy(msg);
        break;
      case 'popup-postMessage':
        handlePopupPost(msg);
        break;
      case 'navigate':
        handleNavigate(msg);
        break;
      case 'request-snapshot':
        handleRequestSnapshot(bc);
        break;
      case 'get-user-account-settings':
        void handleGetUserAccountSettings(msg, bc);
        break;
      case 'get-user-country':
        void handleGetUserCountry(msg, bc);
        break;
      case 'get-user-language':
        void handleGetUserLanguage(msg, bc);
        break;
      case 'activate-product-key':
        void handleActivateProductKey(msg, bc);
        break;
      case 'get-machine-id':
        void handleGetMachineId(msg, bc);
        break;
      case 'open-window':         winHandlers.handleOpenWindow(msg); break;
      case 'window-show':         winHandlers.handleShow(msg); break;
      case 'window-hide':         winHandlers.handleHide(msg); break;
      case 'window-close':        winHandlers.handleClose(msg); break;
      case 'window-bring':        winHandlers.handleBring(msg); break;
      case 'window-postMessage':  winHandlers.handlePostMessage(msg); break;
      // window-user-close is SharedToMain (wrapper iframe → relay), not
      // MainToShared — cast keeps narrowing local to this case.
      case 'window-user-close':
        winHandlers.handleUserClose(msg as unknown as Parameters<typeof winHandlers.handleUserClose>[0]);
        break;
      default:
        break; // shared->main responses + window-set-title (wrapper-direct); relay ignores
    }
  });

  // Install the push-based user-data listener after the BC subscription is up.
  // It broadcasts `user-snapshot` on every relevant change. Wiring the BC
  // handler first means main shell listeners (and re-injected relays) see
  // broadcasts from the very first callback.
  installPushUserChangeListener(scope, bc);

  // Single relay-side bridge instance for external-window relay.
  // `createBridge()` reassigns `window.__sb_resolve` each call, but the
  // underlying `pending` map and `nextId` counter are module-level —
  // multiple createBridge() calls are functionally idempotent.
  //
  const relayBridge = createBridge();
  hideNativeBridgeGlobal();

  // Wire external-window relay: subscribes to MWBM store changes and
  // handles open/setUrl/close/native-title BC messages from main shell.
  // MWBM is available only in SharedJSContext — this is the right place.
  const mwbmStore = (window as any).MainWindowBrowserManager?.m_tabbedBrowserStore;
  if (mwbmStore) {
    setupExternalWindowRelay({
      bcChannel: bc,
      mwbmStore,
      bridge: relayBridge,
    });
  } else {
    console.warn('[booster-relay] MWBM not available at bootstrap; external-window disabled');
  }

  function showPopupNative(entry: PopupEntry, popupId: string, x: number, y: number): void {
    if (entry.visible) return;
    const sc = entry.win.SteamClient?.Window;
    // Display-scale compensation: Steam's MoveTo/ResizeTo take a 3rd
    // `scale` arg that maps logical (CSS) coords to device coords. Steam's
    // own contextmenu code passes `parentWin.devicePixelRatio` (search for
    // `flScaleToTargetMonitor??this.parentWin?.devicePixelRatio` in
    // library.js) — we mirror that. On a 125% Windows display
    // devicePixelRatio is 1.25; passing scale=1 would shrink our popup to
    // 80% (e.g. 320 -> 256) as caller-visible CSS pixels because Steam
    // would interpret the input as device pixels and downscale to logical.
    const dpr = window.devicePixelRatio || 1;
    try { sc?.MoveTo?.(Math.round(x), Math.round(y), dpr); } catch { /* */ }
    try { sc?.ResizeTo?.(entry.width, entry.height, dpr); } catch { /* */ }
    try { sc?.ShowWindow?.(); } catch { /* */ }
    try { sc?.BringToFront?.(); } catch { /* */ }
    // SetKeyFocus pre-empts the blur-poll: without focus, the next 150ms
    // poll sees document.hasFocus()=false (because the user's click landed
    // on the trigger button in the parent window, not the popup) and
    // hidePopupNative fires immediately. Giving the popup keyboard focus
    // on show means the first poll passes; only a real "click outside"
    // moves focus back to the parent window, which is exactly the
    // dismiss signal we want.
    try { sc?.SetKeyFocus?.(true); } catch { /* */ }
    entry.lastStateChangeAt = performance.now();
    entry.visible = true;
    bc.postMessage({ kind: 'popup-show-event', popupId });
  }

  function hidePopupNative(entry: PopupEntry, popupId: string, emitEvent: boolean): void {
    if (!entry.visible) return;
    const sc = entry.win.SteamClient?.Window;
    try { sc?.HideWindow?.(); } catch { /* */ }
    entry.visible = false;
    entry.lastStateChangeAt = performance.now();
    if (emitEvent) {
      bc.postMessage({ kind: 'popup-hide-event', popupId });
    }
  }

  function handleAttachPopup(msg: AttachPopupRequest): void {
    try {
      // Defense-in-depth validation — relay re-checks the popupId regex
      // and html-size cap even though ui.ts validates on the way in.
      // The framework + relay live in different JS realms (main shell vs
      // SharedJSContext); a malicious or buggy framework instance could
      // bypass ui.ts validation by posting straight to the BC channel.
      if (!POPUP_ID_RE.test(msg.popupId)) {
        bc.postMessage({
          kind: 'popup-attach-error',
          requestId: msg.requestId,
          popupId: msg.popupId,
          error: 'invalid popupId (regex)',
        });
        return;
      }
      if (typeof msg.html !== 'string' || msg.html.length > POPUP_HTML_MAX_BYTES) {
        bc.postMessage({
          kind: 'popup-attach-error',
          requestId: msg.requestId,
          popupId: msg.popupId,
          error: `html too large (>${POPUP_HTML_MAX_BYTES} bytes)`,
        });
        return;
      }

      // Defense-in-depth: single-namespace — an open-window already using
      // this id would be corrupted by attachPopup's `removeTrackedZombies`
      // prefix scan (wrapper popup has name `${id}_uid0` matching the scan).
      // Spec § 5: attachPopup and openWindow cannot share an id.
      if (windows.has(msg.popupId)) {
        bc.postMessage({
          kind: 'popup-attach-error',
          requestId: msg.requestId,
          popupId: msg.popupId,
          error: 'id collides with another popup or window',
        });
        return;
      }

      // Idempotent reuse: if a popup with this id already exists (re-inject
      // in same Steam JS context), update its content and reply OK without
      // spawning a new native window. Two liveness checks — Steam's
      // Popup-instance flag (`BIsClosed`) and the underlying Window's own
      // `closed` property. They can disagree: an externally-destroyed CEF
      // window (GPU process restart, OOM-recovery) flips Window.closed to
      // true without going through Steam's Popup.Close path, so BIsClosed
      // stays false. If we trusted only BIsClosed, we'd `document.write`
      // into a dead window and silently no-op all subsequent shows.
      const existing = popups.get(msg.popupId);
      if (existing && !existing.popup.BIsClosed?.() && !existing.win.closed) {
        // Reuse fast-path: update content inline without re-running CEF warmup.
        let rewriteOk = false;
        try {
          existing.win.document.open();
          existing.win.document.write(msg.html);
          existing.win.document.close();
          rewriteOk = true;
        } catch (e) {
          nativeWarn('reuse path: document.write threw', { popupId: msg.popupId, error: String(e) });
        }
        if (!rewriteOk) {
          // Reused window's document is unrecoverable — drop the entry so
          // the next attach builds a fresh popup, and surface the error
          // now instead of letting the caller's `await` resolve happily
          // and then break on the next show.
          if (existing.blurPollHandle !== null) clearInterval(existing.blurPollHandle);
          destroyPopup(existing.popup, existing.win);
          popups.delete(msg.popupId);
          bc.postMessage({
            kind: 'popup-attach-error',
            requestId: msg.requestId,
            popupId: msg.popupId,
            error: 'reused popup document.write failed',
          });
          return;
        }
        existing.width = msg.width;
        existing.height = msg.height;
        existing.hideOnBlur = msg.hideOnBlur;
        existing.lastStateChangeAt = 0; // reset gate stamp — fresh content / re-attach is semantically a new popup
        bc.postMessage({
          kind: 'popup-attached',
          requestId: msg.requestId,
          popupId: msg.popupId,
        });
        return;
      }

      // Defer to microtask. Two reasons it's still here even though the
      // BrowserView+window.open path is gone:
      //   1) `new PopupClass(...) + .Show()` ultimately calls Steam's
      //      `T.CreatePopup` which is the same CEF popup-creation primitive
      //      that deadlocks inside a BC handler context. Letting the BC
      //      handler return first sidesteps that whole class of races.
      //   2) Lets the entire body live behind a single try/catch that
      //      always posts a popup-attach-error on any failure path, so
      //      callers' `await attachPopup` never hangs to the 5s timeout.
      Promise.resolve().then(() => attachPopupMicrotask(msg));
    } catch (e) {
      bc.postMessage({
        kind: 'popup-attach-error',
        requestId: msg.requestId,
        popupId: msg.popupId,
        error: String(e),
      });
    }
  }

  function attachPopupMicrotask(msg: AttachPopupRequest): void {
    try {
      if (tornDown) {
        nativeWarn('attach-popup raced relay teardown', {
          popupId: msg.popupId,
          popupCount: popups.size,
        });
        return;
      }

      // flagOpts from the request — individual flag overrides from the
      // requesting plugin. Absent fields default inside buildAttachPopupFlags
      // to the Steam-native dropdown flag set STEAM_DROPDOWN_FLAGS = 4538634.
      const result = createChromelessPopup({
        popupId: msg.popupId,
        html: msg.html,
        width: msg.width,
        height: msg.height,
        flagOpts: {
          alwaysOnTop:       msg.alwaysOnTop,
          nativeBorder:      msg.nativeBorder,
          noTaskbarIcon:     msg.noTaskbarIcon,
          noWindowShadow:    msg.noWindowShadow,
          noRoundedCorners:  msg.noRoundedCorners,
          composited:        msg.composited,
          transparentParent: msg.transparentParent,
          overrideRedirect:  msg.overrideRedirect,
        },
      });

      if (!result) {
        bc.postMessage({
          kind: 'popup-attach-error',
          requestId: msg.requestId,
          popupId: msg.popupId,
          error: 'createChromelessPopup returned null (g_PopupManager template unavailable, ctor threw, m_popup unset, or rewriteContent failed)',
        });
        return;
      }

      const { popup, popupWin } = result;

      // Blur-poll setup (kept here — depends on closure-local popups Map).
      let blurPollHandle: number | null = null;
      if (msg.hideOnBlur) {
        blurPollHandle = scope.setInterval(() => {
          const entry = popups.get(msg.popupId);
          if (!entry || !entry.visible || entry.popup.BIsClosed?.()) return;
          try {
            if (!entry.win.document.hasFocus()) {
              hidePopupNative(entry, msg.popupId, true);
            }
          } catch {
            // popup window may have transient state during nav
          }
        }, BLUR_POLL_MS);
      }

      popups.set(msg.popupId, {
        popup: popup as SteamPopupInstance,
        win: popupWin as SteamPopupWindow,
        visible: false,
        width: msg.width,
        height: msg.height,
        hideOnBlur: msg.hideOnBlur,
        blurPollHandle,
        lastStateChangeAt: 0,
      });

      bc.postMessage({
        kind: 'popup-attached',
        requestId: msg.requestId,
        popupId: msg.popupId,
      });
    } catch (e) {
      nativeWarn('attach-popup microtask threw', {
        popupId: msg.popupId, popupCount: popups.size, error: String(e),
      });
      bc.postMessage({
        kind: 'popup-attach-error',
        requestId: msg.requestId,
        popupId: msg.popupId,
        error: 'microtask threw: ' + String(e),
      });
    }
  }

  function handlePopupShow(msg: PopupShowRequest): void {
    const entry = popups.get(msg.popupId);
    if (!entry || entry.popup.BIsClosed?.()) {
      // Either the caller raced ahead of the attach microtask (see the
      // microtask defer comment in handleAttachPopup) or used an unknown
      // popupId. Both are programmer errors worth a breadcrumb.
      nativeWarn('popup-show for unknown popupId', { popupId: msg.popupId });
      return;
    }
    showPopupNative(entry, msg.popupId, msg.x, msg.y);
  }

  function handlePopupHide(msg: PopupHideRequest): void {
    const entry = popups.get(msg.popupId);
    if (!entry || entry.popup.BIsClosed?.()) {
      nativeWarn('popup-hide for unknown popupId', { popupId: msg.popupId });
      return;
    }
    hidePopupNative(entry, msg.popupId, true);
  }

  function handlePopupToggle(msg: PopupToggleRequest): void {
    const entry = popups.get(msg.popupId);
    if (!entry || entry.popup.BIsClosed?.()) {
      nativeWarn('popup-toggle for unknown popupId', { popupId: msg.popupId });
      return;
    }
    const now = performance.now();
    if (now - entry.lastStateChangeAt < getGateMs()) {
      return;   // gate hit — consume call
    }
    if (entry.visible) {
      hidePopupNative(entry, msg.popupId, true);
    } else {
      showPopupNative(entry, msg.popupId, msg.x, msg.y);
    }
  }

  function handlePopupDestroy(msg: PopupDestroyRequest): void {
    const entry = popups.get(msg.popupId);
    if (!entry) return;  // destroy is idempotent — silent no-op is fine
    if (entry.blurPollHandle !== null) clearInterval(entry.blurPollHandle);
    try { entry.popup.Close?.(); } catch { /* */ }
    popups.delete(msg.popupId);
  }

  function handlePopupPost(msg: PopupPostMessageRequest): void {
    // Best-effort fallback delivery for popups that prefer DOM message
    // events over BroadcastChannel. The PRIMARY delivery path for
    // `popup-postMessage` is BC: ui.ts broadcasts it on `sb_cmd`, popups
    // that subscribe (booster-checkout's popup.html does) receive it directly.
    // This relay handler additionally calls entry.win.postMessage — a
    // DOM-message backup that helps a popup wired via legacy
    // window.addEventListener('message', ...). Both paths are wasted on
    // a BC-only popup but harmless.
    //
    // Intentionally NO `nativeWarn` on missing entry: BC delivery is the
    // primary path and races with relay teardown / re-injection routinely
    // produce a popup-postMessage that arrives while our `popups` map is
    // empty. Logging on every such miss creates noise that doesn't
    // correlate with a user-visible failure.
    const entry = popups.get(msg.popupId);
    if (!entry || entry.popup.BIsClosed?.()) return;
    try {
      entry.win.postMessage(msg.data, '*');
    } catch {
      // popup may have transient state
    }
  }

  function handleNavigate(msg: NavigateRequest): void {
    try {
      if (typeof msg.url !== 'string' || msg.url.length > 2048 || !isUrlSafeForNavigation(msg.url)) {
        bc.postMessage({
          kind: 'navigate-error',
          requestId: msg.requestId,
          error: `url failed safety check: ${safeHostForLog(String(msg.url))}`,
        });
        return;
      }
      if (!window.MainWindowBrowserManager?.LoadURL) {
        bc.postMessage({
          kind: 'navigate-error',
          requestId: msg.requestId,
          error: 'MWBM unavailable',
        });
        return;
      }
      window.MainWindowBrowserManager.LoadURL(msg.url);
      bc.postMessage({ kind: 'navigate-done', requestId: msg.requestId });
    } catch (e) {
      bc.postMessage({
        kind: 'navigate-error',
        requestId: msg.requestId,
        error: String(e),
      });
    }
  }

  const teardown = (): void => {
    // Set tornDown FIRST so any in-flight attach microtask sees the flag
    // before construction fires — see handleAttachPopup's microtask check.
    tornDown = true;
    // Destroy all popup native windows so Steam doesn't accumulate orphans
    // across steambooster restarts (the chief cause of the 11-popup mess
    // observed on first DOM-pivot test cycle, AND the cause of the "no
    // button after re-inject" symptom: when a popup hangs around in
    // g_PopupManager registered to its name, the next attachPopup with the
    // same id fails with `popup.m_popup unset after Show` because Steam
    // refuses to register a duplicate). The popup creation path explicitly
    // calls SetHideOnClose(true) in popup-factory.ts → commonPopupSetup
    // (in popup-lifecycle.ts) so a plain Close() hides the
    // popup instead of destroying it — we have to undo that flag first,
    // then call Close, then call the DOM Window.close as belt-and-braces
    // for the case where Steam's Close honours SetHideOnClose unconditionally.
    //
    // Blur-poll setInterval handles are NOT cleared manually — `scope._abort()`
    // below clears them natively through the AbortSignal. If teardown is
    // called before lifecycle.rollbackAll (e.g. from a C++ Rollback path),
    // the abort still happens here; if the scope is already aborted
    // (lifecycle.rollbackAll fired first), the repeat abort() is a no-op.
    // Per-popup destruction — `destroyPopup` from popup-lifecycle.ts
    // carries the load-bearing four-step order and is shared by the
    // reuse-path failure branch in handleAttachPopup.
    for (const [id, entry] of popups) {
      destroyPopup(entry.popup, entry.win);
      popups.delete(id);
    }
    // Abort scope after popup destroy: Steam-popup loop above is
    // synchronous, but if anything in it did want to read from a
    // scope-tracked resource (it doesn't today, but defense), the
    // resources are still alive. Abort fires AFTER the loop. The bc
    // listener detaches via signal at this point; bc.close() finalizes.
    try { scope._abort(); } catch { /* swallow */ }
    // Tear down external-window relay: unsubscribes from MWBM store,
    // clears entries and bridge ref. Must run before bc.close() so any
    // final broadcasts (none expected on teardown) can still post.
    try { teardownExternalWindowRelay(); } catch { /* swallow */ }
    bc.close();
    window.__sb_relay_started = false;
    if (window.__sb_relay_teardown === teardown) {
      window.__sb_relay_teardown = undefined;
    }
  };
  window.__sb_relay_teardown = teardown;
  return teardown;
}
