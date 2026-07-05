import type {
  UiApi,
  HeaderButtonOptions,
  HeaderButtonHandle,
  AttachedPopupOptions,
  AttachedPopupHandle,
  OpenWindowOptions,
  OpenWindowHandle,
  MenuItemOptions,
  MenuItemHandle,
  StoreNavButtonOptions,
  StoreNavButtonHandle,
} from './api-types';
import { createExternalWindowApi } from './external-window';
import type { Registry } from '../registry';
import type { Bridge } from '../bridge';
import { waitForToolbar } from '../steam-internals/header-selectors';
import { findStoreNav } from '../steam-internals/store-nav-selectors';
import {
  POPUP_ID_RE, OPEN_WINDOW_HTML_MAX_BYTES, WINDOW_MESSAGE_MAX_BYTES,
  MENU_ITEM_ID_RE, MENU_ITEM_LABEL_MAX, MENU_ITEM_ICON_MAX_BYTES,
  type OpenWindowResponse,
  type WindowSetTitleRequest,
} from '../relay/protocol';
import { createRelayChannel, isTagged, stripTag } from '../relay/channel';
import { nativeWarn } from '../native-warn';
import { ensureToolbarStyles } from './ui-toolbar-styles';
import { ensureStoreNavStyles } from './ui-storenav-styles';
import { wireTooltip } from './ui-tooltip';
import { isUrlSafeForNavigation } from './steam';
import { sanitizeIconSvg } from './svg-sanitize';

const ATTACH_TIMEOUT_MS = 5000;
// Poll interval for the store-nav button's reconcile loop (re-mount after a
// React-driven wipe of the row). Mirrors the MutationObserver but also
// covers the case where `row` itself was replaced wholesale (a fresh row
// element the observer isn't attached to).
const STORENAV_RECONCILE_MS = 800;
// Shorter RPC timeout for add-menu-item so a message dropped on a not-yet-ready
// relay (fresh launch) surfaces fast and the caller's idempotent retry re-posts.
const MENU_ITEM_ATTACH_TIMEOUT_MS = 1500;
// Cap our requestId space so it never collides with steam.ts (which starts
// at STEAM_REQUEST_ID_BASE = 100_000). Process-wide unique IDs would be
// nicer, but ui+steam are independent module instances and this static cap
// is simpler. If we ever exceed 100k attach-popup calls in a single
// session, something is very wrong.
const UI_REQUEST_ID_MAX = 99_999;

interface PopupListenerSets {
  message: Set<(d?: unknown) => void>;
  show: Set<() => void>;
  hide: Set<() => void>;
  undoId: number;
}

export function makeUiApi(registry: Registry, bridge: Bridge, relaySecret?: string): UiApi {
  // Authenticated relay channel: outbound popup/window posts carry the
  // per-launch secret; inbound replies/events lacking the tag are dropped.
  // undefined ⇒ untagged passthrough (tests / pre-secret injector).
  const ch = createRelayChannel(relaySecret);
  // Register the BC instance with the registry so on framework re-injection
  // (lifecycle.rollbackAll), this BC is closed and its listeners released.
  // Without this hook, every re-inject leaks a live message subscription.
  let nextRequestId = 1;

  // Pending RPCs (attach-popup, open-window). All other UI BC traffic
  // (show / hide / toggle / postMessage / window-set-title / etc.) is
  // fire-and-forget.
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const popupListeners = new Map<string, PopupListenerSets>();
  // Parallel to popupListeners but for openWindow handles. Keyed by windowId
  // (distinct namespace from popupId — relay validates non-collision). Each
  // entry holds the listener Sets for show/hide/close/message events.
  const windowListeners = new Map<string, {
    show: Set<() => void>;
    hide: Set<() => void>;
    close: Set<(d?: unknown) => void>;
    message: Set<(d?: unknown) => void>;
    /** Registry undo entry id so the close-event handler can drop the entry
     *  on user-X-close (no leak in the registry until rollbackAll). Set
     *  after registry.push returns; cleared in the close-event branch. */
    undoId?: number;
  }>();

  ch.raw.addEventListener('message', (ev: MessageEvent) => {
    let msg = ev.data as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object') return;
    // Inbound auth: drop untagged/mistagged messages — EXCEPT `popup-message`,
    // whose only legitimate source is the plugin-authored attachPopup popup
    // HTML, which carries no secret (the relay never composes it with one).
    // popup-message merely fires the owning popup handle's on('message')
    // listeners (scoped by popupId) — accepting it untagged is the documented
    // carve-out analogous to the tabbed-shell one.
    if (msg['kind'] !== 'popup-message' && !isTagged(msg, relaySecret)) return;
    msg = stripTag(msg);

    const requestId =
      typeof msg['requestId'] === 'number' ? (msg['requestId'] as number) : undefined;
    const popupId = typeof msg['popupId'] === 'string' ? (msg['popupId'] as string) : undefined;
    const kind = msg['kind'];

    // Only RPC-reply kinds may evict a pending entry. Non-reply kinds
    // (popup-message, popup-show-event, etc.) must NOT touch pending —
    // an untagged popup-message with a matching requestId would otherwise
    // silently evict an in-flight attachPopup/openWindow, causing its
    // await to hang forever (the timeout guard also no-ops once
    // pending.has returns false).
    if (requestId !== undefined && pending.has(requestId)) {
      if (kind === 'popup-attached' || kind === 'popup-attach-error'
          || kind === 'window-opened' || kind === 'window-open-error'
          || kind === 'menu-item-added' || kind === 'menu-item-error') {
        const p = pending.get(requestId)!;
        pending.delete(requestId);
        if (kind === 'popup-attached') p.resolve(msg);
        else if (kind === 'popup-attach-error') {
          p.reject(new Error(typeof msg['error'] === 'string' ? msg['error'] : 'relay error'));
        }
        // openWindow uses the same shared `attachRequest` machinery (single
        // requestId space, same pending map) — route window-opened/error to
        // the same resolve/reject path so callers don't hang on the timer.
        else if (kind === 'window-opened') p.resolve(msg);
        else if (kind === 'window-open-error') {
          p.reject(new Error(typeof msg['error'] === 'string' ? msg['error'] : 'open-window error'));
        }
        // addMenuItem — same shared attachRequest machinery.
        else if (kind === 'menu-item-added') p.resolve(msg);
        else if (kind === 'menu-item-error') {
          p.reject(new Error(typeof msg['error'] === 'string' ? msg['error'] : 'menu-item error'));
        }
      }
    }

    if (popupId && popupListeners.has(popupId)) {
      const sets = popupListeners.get(popupId)!;
      if (msg['kind'] === 'popup-message') {
        for (const cb of sets.message) {
          try { cb(msg['data']); } catch { /* */ }
        }
      } else if (msg['kind'] === 'popup-hide-event') {
        for (const cb of sets.hide) {
          try { cb(); } catch { /* */ }
        }
      } else if (msg['kind'] === 'popup-show-event') {
        for (const cb of sets.show) {
          try { cb(); } catch { /* */ }
        }
      }
    }

    // openWindow event dispatch: relay → MainShell pushes window-show-event /
    // window-hide-event / window-close-event / window-message keyed by
    // `windowId`. Mirrors the popupId block above. close-event also evicts
    // the listener entry so subsequent events for the same id (including
    // re-opens) don't fire stale callbacks.
    const windowId = typeof msg['windowId'] === 'string' ? (msg['windowId'] as string) : undefined;
    if (windowId && windowListeners.has(windowId)) {
      const sets = windowListeners.get(windowId)!;
      if (msg['kind'] === 'window-show-event') {
        for (const cb of sets.show)    { try { cb(); } catch { /* */ } }
      } else if (msg['kind'] === 'window-hide-event') {
        for (const cb of sets.hide)    { try { cb(); } catch { /* */ } }
      } else if (msg['kind'] === 'window-close-event') {
        for (const cb of sets.close)   { try { cb(msg['reason']); } catch { /* */ } }
        // Drop the registry entry too so a later rollbackAll doesn't iterate
        // a stale undo for a window that's already destroyed. Without this,
        // the user-X-close path leaked an undo entry until full rollbackAll.
        if (sets.undoId !== undefined) {
          try { registry.remove(sets.undoId); } catch { /* */ }
        }
        windowListeners.delete(windowId);
      } else if (msg['kind'] === 'window-message') {
        for (const cb of sets.message) { try { cb(msg['data']); } catch { /* */ } }
      }
    }
  });

  // Top-level BC teardown: closing the channel releases the message listener
  // and unsubscribes us from cross-context dispatch. Registered as a registry
  // entry so lifecycle.rollbackAll picks it up on framework re-inject.
  registry.push({
    description: 'ui-bc',
    undo: () => {
      try { ch.close(); } catch { /* */ }
      pending.clear();
      popupListeners.clear();
      windowListeners.clear();
    },
  });

  // Share the same underlying channel; external-window.ts tags its own
  // outbound (open/set-url/close) and filters its inbound (open-reply/
  // close-event) via the secret so the relay accepts them.
  const externalWindowApi = createExternalWindowApi({ bcChannel: ch.raw, relaySecret });

  function attachRequest<T>(req: Record<string, unknown>, timeoutMs: number = ATTACH_TIMEOUT_MS): Promise<T> {
    if (nextRequestId > UI_REQUEST_ID_MAX) {
      // Hit the cap — would collide with steam.ts's id space (>=100_000)
      // on the same BC channel. Treat as fatal for this attempt; caller
      // sees a rejected promise, registry/plugin can decide next steps.
      return Promise.reject(new Error(
        `attachRequest: ui requestId exhausted (>${UI_REQUEST_ID_MAX})`,
      ));
    }
    const requestId = nextRequestId++;
    const message = { ...req, requestId };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(new Error(`attachRequest timeout ${timeoutMs}ms`));
        }
      }, timeoutMs);
      pending.set(requestId, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ch.post(message);
    });
  }

  return {
    addHeaderButton(opts: HeaderButtonOptions): HeaderButtonHandle {
      const hasClick = opts.onClick !== undefined;
      const hasToggle = opts.togglePopup !== undefined;
      if (hasClick === hasToggle) {
        throw new Error(
          'addHeaderButton: provide exactly one of onClick or togglePopup '
          + `(got onClick=${hasClick}, togglePopup=${hasToggle})`,
        );
      }

      ensureToolbarStyles();
      const button = document.createElement('div');
      button.id = opts.id;
      button.setAttribute('data-sb', '1');
      // Selector hook for the styles injected by ensureToolbarStyles. The
      // attribute (vs a class) is intentionally namespaced with `booster-` so it
      // never collides with Steam's own CSS-modules class chatter.
      button.setAttribute('data-booster-btn', '');
      // Optional brand variant — SteamBalance green CTA cascade in
      // ui-toolbar-styles.ts. Grouped with other data-booster-* attributes
      // so all selector hooks live together.
      if (opts.variant === 'brand') {
        button.setAttribute('data-booster-variant', 'brand');
      }
      // Steam's toolbar items wear `tool-tip-source Focusable` — adding the
      // pair makes our button visually + behaviourally indistinguishable
      // from Магазин / Библиотека / bell. Focusable wires Steam's keyboard
      // focus management (so the button takes part in the existing tab
      // order); tool-tip-source hooks the native tooltip surface.
      button.classList.add('tool-tip-source', 'Focusable');
      const inner = document.createElement('div');
      inner.className = 'booster-toolbar-inner';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'booster-toolbar-label';
      labelSpan.textContent = opts.label;
      inner.appendChild(labelSpan);

      if (opts.icon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'booster-toolbar-icon';
        // SECURITY: opts.icon goes via innerHTML for the SVG branch.
        // Trust boundary documented in api-types.ts HeaderButtonOptions.icon
        // JSDoc — caller passes build-time constants only. Framework does
        // NOT sanitise.
        // Case-insensitive per RFC 2397 / 2045 — `Data:Image/PNG;...`
        // is technically valid; without /i a typo would silently fall
        // through to the innerHTML branch and render as plain text.
        if (/^data:image\//i.test(opts.icon)) {
          const img = document.createElement('img');
          img.src = opts.icon;
          img.alt = '';
          iconSpan.appendChild(img);
        } else {
          iconSpan.innerHTML = opts.icon;
        }
        inner.appendChild(iconSpan);
      }

      button.appendChild(inner);
      // Steam-style tooltip via wireTooltip — replaces the previous
      // `button.title = opts.tooltip` which surfaced the Windows-native
      // (ugly, OS-themed) tooltip. Steam's own toolbar items use a
      // React-rendered floating bubble; we mimic the exact visual
      // (radial gradient, dark text, layered shadow — see SB_TOOLBAR_CSS
      // .booster-tooltip block). Both `tooltip` callers and listeners are
      // tied to the registry undo so framework re-injection cleans up.
      const tooltipUndo = opts.tooltip ? wireTooltip(button, opts.tooltip) : null;

      let busy = false;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (opts.togglePopup) {
          // togglePopup branch — sync. Relay-side gate handles double-click debounce.
          const popup = opts.togglePopup;
          const rect = button.getBoundingClientRect();
          const x = window.screenX + rect.right - popup.width;
          const y = window.screenY + rect.bottom;
          popup.toggle({ x, y });
          return;
        }
        // onClick branch (busy guard for re-entry on async handler).
        if (busy) return;
        busy = true;
        void (async () => {
          try { await opts.onClick!({ rect: button.getBoundingClientRect() }); }
          catch { /* best-effort */ }
          finally { busy = false; }
        })();
      });

      let aborted = false;
      const undoId = registry.push({
        description: `headerButton:${opts.id}`,
        undo: () => {
          aborted = true;
          if (tooltipUndo) tooltipUndo();
          button.remove();
        },
      });

      void (async () => {
        const toolbar = await waitForToolbar();
        if (aborted) return;
        if (!toolbar) {
          bridge.notify('log', 'booster-framework', {
            level: 'error',
            msg: 'addHeaderButton: toolbar not found',
            meta: {
              feature: 'addHeaderButton',
              id: opts.id,
              reason: 'selector-not-found',
            },
          });
          return;
        }
        const placement = opts.placement ?? 'before-profile';
        // `before-profile` is the user-requested default: insert just
        // before the profile+balance widget. The toolbar layout we
        // observed is [voice, bell, profile, ..., chat] — bell is
        // already the last sibling before profile, so this slot lands
        // the button between bell and profile, matching the user's
        // explicit ask ("после нотификаций и до профиля").
        const avatar = toolbar.querySelector('.avatarHolder');
        const profileFocusable = avatar?.closest('.Focusable');
        if (placement === 'before-profile' && profileFocusable) {
          toolbar.insertBefore(button, profileFocusable);
        } else if (placement === 'before-notifications' && toolbar.lastElementChild) {
          toolbar.insertBefore(button, toolbar.lastElementChild);
        } else if (placement === 'after-profile') {
          if (profileFocusable && profileFocusable.nextSibling) {
            toolbar.insertBefore(button, profileFocusable.nextSibling);
          } else {
            toolbar.appendChild(button);
          }
        } else {
          toolbar.appendChild(button);
        }
      })();

      return {
        remove(): void {
          if (tooltipUndo) tooltipUndo();
          button.remove();
          registry.remove(undoId);
        },
        setLabel(s: string): void {
          // Update only the label span — preserves the optional icon span
          // sibling. Setting `inner.textContent` would wipe both.
          labelSpan.textContent = s;
        },
        setEnabled(on: boolean): void {
          // aria-disabled pairs with the [aria-disabled="true"] selector
          // in SB_TOOLBAR_CSS for visual treatment. We also pull the
          // button out of the keyboard tab order with tabindex="-1" so
          // a Tab traversal doesn't land on a disabled control —
          // aria-disabled alone leaves the element focusable, which
          // Steam's `Focusable` infra would happily click-on-Enter.
          // pointerEvents: none stops mouse clicks from firing the
          // handler (CSS cursor alone wouldn't, since hover events
          // wouldn't reach the disabled element anyway).
          if (on) {
            button.removeAttribute('aria-disabled');
            button.removeAttribute('tabindex');
            button.style.pointerEvents = '';
          } else {
            button.setAttribute('aria-disabled', 'true');
            button.setAttribute('tabindex', '-1');
            button.style.pointerEvents = 'none';
          }
        },
        getRect(): DOMRect {
          return button.getBoundingClientRect();
        },
      };
    },

    async attachPopup(opts: AttachedPopupOptions): Promise<AttachedPopupHandle> {
      if (!POPUP_ID_RE.test(opts.id)) {
        throw new Error(`attachPopup: invalid id "${opts.id}" (allowed: [a-zA-Z0-9_-]{1,64})`);
      }
      if (!Number.isFinite(opts.width) || opts.width <= 0) {
        nativeWarn('attachPopup: invalid width', { popupId: opts.id, width: opts.width });
      }
      if (opts.height !== undefined && (!Number.isFinite(opts.height) || opts.height <= 0)) {
        nativeWarn('attachPopup: invalid height', { popupId: opts.id, height: opts.height });
      }
      const widthClamped = Math.max(40, Math.min(opts.width | 0, 1200));
      const heightClamped = Math.max(40, Math.min((opts.height ?? 200) | 0, 800));
      const hideOnBlur = opts.hideOnBlur ?? true;

      let visible = false;
      // Register listener sets and registry undo BEFORE awaiting attachRequest
      // so that any popup-show-event / popup-hide-event BC messages that
      // arrive during the attach roundtrip are not silently dropped.
      const sets: PopupListenerSets = {
        message: new Set(),
        show: new Set(),
        hide: new Set(),
        undoId: registry.push({
          description: `popup:${opts.id}`,
          undo: () => {
            // Fire-and-forget: relay's teardown also Closes() the popup, but
            // calling out here on framework rollback ensures no orphan even
            // if relay hasn't started yet (race on injection ordering).
            try { ch.post({ kind: 'popup-destroy', popupId: opts.id }); } catch { /* */ }
            popupListeners.delete(opts.id);
          },
        }),
      };
      // Visibility tracking is driven ONLY by BC events from the relay.
      // show/hide/toggle are pure fire-and-forget; the relay echoes back
      // popup-show-event / popup-hide-event which update `visible` and fire
      // the listener sets. This avoids the race where local toggle() flipped
      // `visible` before the relay's gate had a chance to consume the call.
      sets.show.add(() => { visible = true; });
      sets.hide.add(() => { visible = false; });
      popupListeners.set(opts.id, sets);

      // attach-popup is the only awaiting RPC. Show / hide / toggle /
      // postMessage are fire-and-forget — relay drives a SINGLE pre-allocated
      // native popup window per popupId; toggling it never spawns extras.
      try {
        await attachRequest<{ kind: 'popup-attached'; popupId: string }>({
          kind: 'attach-popup',
          popupId: opts.id,
          html: opts.html,
          width: widthClamped,
          height: heightClamped,
          hideOnBlur,
          alwaysOnTop:       opts.alwaysOnTop,
          nativeBorder:      opts.nativeBorder,
          noTaskbarIcon:     opts.noTaskbarIcon,
          noWindowShadow:    opts.noWindowShadow,
          noRoundedCorners:  opts.noRoundedCorners,
          composited:        opts.composited,
          transparentParent: opts.transparentParent,
          overrideRedirect:  opts.overrideRedirect,
        });
      } catch (e) {
        // Clean up the eagerly registered state so partial failures don't
        // leave orphaned entries in popupListeners or the registry.
        popupListeners.delete(opts.id);
        registry.remove(sets.undoId);
        throw e;
      }

      return {
        width:  widthClamped,
        height: heightClamped,
        show(at): void {
          ch.post({ kind: 'popup-show', popupId: opts.id, x: at.x, y: at.y });
        },
        hide(): void {
          ch.post({ kind: 'popup-hide', popupId: opts.id });
        },
        toggle(at): void {
          ch.post({ kind: 'popup-toggle', popupId: opts.id, x: at.x, y: at.y });
        },
        postMessage(data): void {
          ch.post({ kind: 'popup-postMessage', popupId: opts.id, data });
        },
        on(event, cb): () => void {
          const set = sets[event];
          set.add(cb);
          return () => { set.delete(cb); };
        },
        isVisible(): boolean {
          return visible;
        },
        destroy(): void {
          ch.post({ kind: 'popup-destroy', popupId: opts.id });
          popupListeners.delete(opts.id);
          registry.remove(sets.undoId);
        },
      };
    },

    async openWindow(opts: OpenWindowOptions): Promise<OpenWindowHandle> {
      // ── Sync validation (throws BEFORE posting any BC message) ──
      // Mirrors the relay-side checks in window-handlers.ts so callers see
      // the same failure mode locally without round-tripping. The relay
      // double-checks anyway (defense in depth: an in-process attacker who
      // bypasses the framework still hits relay validation).
      if (!POPUP_ID_RE.test(opts.id))
        throw new Error(`openWindow: invalid id "${opts.id}"`);
      const hasUrl  = opts.url  !== undefined && opts.url.length  > 0;
      const hasHtml = opts.html !== undefined && opts.html.length > 0;
      if (hasUrl && hasHtml)
        throw new Error('openWindow: url and html are mutually exclusive');
      if (!hasUrl && !hasHtml)
        throw new Error('openWindow: either url or html is required');
      if (typeof opts.title !== 'string' || opts.title.length === 0)
        throw new Error('openWindow: title is required');
      if (!Number.isFinite(opts.width)  || opts.width  <= 0)
        throw new Error('openWindow: invalid width');
      if (!Number.isFinite(opts.height) || opts.height <= 0)
        throw new Error('openWindow: invalid height');
      if (hasUrl && !isUrlSafeForNavigation(opts.url!))
        throw new Error('openWindow: unsafe url');
      if (hasHtml && new TextEncoder().encode(opts.html!).length > OPEN_WINDOW_HTML_MAX_BYTES)
        throw new Error('openWindow: html too large');

      // Local mirrors of last-acked-intent. visible flips on
      // window-show-event/window-hide-event; closed flips on
      // window-close-event OR caller-driven close().
      let visible = false;
      let closed  = false;
      const sets = {
        show:    new Set<() => void>(),
        hide:    new Set<() => void>(),
        close:   new Set<(d?: unknown) => void>(),
        message: new Set<(d?: unknown) => void>(),
        undoId:  undefined as number | undefined,
      };
      // Pre-register listener entry BEFORE attachRequest so any window-*
      // events arriving during the attach roundtrip are not silently
      // dropped (matches the attachPopup pattern).
      windowListeners.set(opts.id, sets);

      const undoId = registry.push({
        description: `openWindow:${opts.id}`,
        undo: () => {
          // Fire-and-forget close + listener teardown. Relay's own teardown
          // will close the popup window separately, but issuing window-close
          // here ensures no orphan even if relay hasn't started yet (race on
          // injection ordering).
          try { ch.post({ kind: 'window-close', windowId: opts.id }); } catch { /* */ }
          windowListeners.delete(opts.id);
        },
      });
      // Stash undoId on the listener entry so the close-event branch in the
      // BC dispatch above can drop the registry entry on user-X-close.
      sets.undoId = undoId;

      // Tie local state-mirrors to the BC-driven event Sets so they reflect
      // last-acked-intent (not future state). isVisible() may briefly lag a
      // call to show()/hide() until the relay echo arrives — same model as
      // attachPopup.
      sets.show.add(()  => { visible = true;  });
      sets.hide.add(()  => { visible = false; });
      sets.close.add(() => { closed  = true;  });

      let resp: OpenWindowResponse;
      try {
        resp = await attachRequest<OpenWindowResponse>({
          kind: 'open-window',
          windowId: opts.id,
          title: opts.title,
          url:    hasUrl  ? opts.url  : undefined,
          html:   hasHtml ? opts.html : undefined,
          width: opts.width, height: opts.height,
          minWidth:  opts.minWidth  ?? 320,
          minHeight: opts.minHeight ?? 240,
          // resizable defaults FALSE to match Steam's own modal exactly.
          // RESIZABLE bit triggers Windows DWM restore-from-taskbar
          // animation; Steam's news modal opens without animation
          // because it omits the bit. Resize behavior comes from
          // Steam's React ModalDialog CSS, not the OS frame.
          resizable:     opts.resizable     ?? false,
          noTaskbarIcon: opts.noTaskbarIcon ?? false,
          alwaysOnTop:   opts.alwaysOnTop   ?? false,
          // composited DEFAULTS OFF for modals — setting it routes Steam to
          // the chromeless code-path where center_on_window + MoveTo break.
          // Caller can opt-in via composited:true if they need GPU compositing
          // (rare; most chat embeds are fine without).
          composited:    opts.composited    ?? false,
          centerOnMain:  opts.centerOnMain  ?? true,
          iframeBackground: opts.iframeBackground,
          embedOrigins: opts.embedOrigins,
        });
      } catch (e) {
        // attachRequest threw (timeout) — clean up eager state so the
        // window-id slot is reusable and the registry doesn't hold a
        // dangling undo for a window that was never created.
        windowListeners.delete(opts.id);
        registry.remove(undoId);
        throw e;
      }
      // Defense-in-depth: BC dispatch (lines 81-84) already rejects the
      // promise on `window-open-error`, so this branch is normally
      // unreachable. Kept in case the dispatch ever stops auto-rejecting
      // (e.g. a new error kind added without symmetric handling).
      if (resp.kind === 'window-open-error') {
        windowListeners.delete(opts.id);
        registry.remove(undoId);
        throw new Error(resp.error ?? 'open-window error');
      }
      const effW = resp.effectiveWidth  ?? opts.width;
      const effH = resp.effectiveHeight ?? opts.height;

      return {
        id: opts.id,
        width:  effW,
        height: effH,
        show(): void {
          if (closed) return;
          ch.post({ kind: 'window-show', windowId: opts.id });
        },
        hide(): void {
          if (closed) return;
          ch.post({ kind: 'window-hide', windowId: opts.id });
        },
        close(): void {
          if (closed) return;
          ch.post({ kind: 'window-close', windowId: opts.id });
          // Eagerly drop the registry entry — the relay will eventually emit
          // window-close-event which would also flip `closed`, but removing
          // here keeps registry size accurate from the caller's perspective
          // and prevents a double-fire on rollbackAll. Mirror attachPopup.destroy:
          // also drop the listener Set so a delayed close-event arriving after
          // BC teardown can't dispatch into a dangling Set.
          windowListeners.delete(opts.id);
          registry.remove(undoId);
        },
        bringToFront(): void {
          if (closed) return;
          ch.post({ kind: 'window-bring', windowId: opts.id });
        },
        setTitle(s: string): void {
          if (closed) return;
          // Wrapper-direct BC: the popup wrapper HTML subscribes to
          // RELAY_CHANNEL on its own and updates the title bar on this
          // event (no relay round-trip needed for a pure UI tweak).
          const msg: WindowSetTitleRequest = { kind: 'window-set-title', windowId: opts.id, title: s };
          ch.post(msg);
        },
        /** Reflects last-acked window-show-event / window-hide-event from the
         *  relay — NOT real-time native state. If SteamClient.Window calls
         *  fail or no-op on the wrapper side, this flag may diverge from
         *  on-screen reality. Acceptable for tech-support / payment use
         *  cases; cross-check via Steam-side BIsVisible() if needed. */
        isVisible(): boolean {
          return visible;
        },
        postMessage(data: unknown): void {
          if (closed) return;
          // url-режим: обёртка мостит в cross-origin iframe; html-режим:
          // relay ре-броадкастит. Cap в обе стороны (mirror BUS_MAX_BYTES).
          let bytes = 0;
          try { bytes = new TextEncoder().encode(JSON.stringify(data)).length; }
          catch { nativeWarn('openWindow.postMessage: unserializable payload', { windowId: opts.id }); return; }
          if (bytes > WINDOW_MESSAGE_MAX_BYTES) {
            nativeWarn('openWindow.postMessage: payload too large', { windowId: opts.id, bytes });
            return;
          }
          ch.post({ kind: 'window-postMessage', windowId: opts.id, data });
        },
        on(event, cb): () => void {
          const set = sets[event];
          set.add(cb);
          return () => { set.delete(cb); };
        },
      };
    },

    openExternalWindow: externalWindowApi.openExternalWindow,

    async addMenuItem(opts: MenuItemOptions): Promise<MenuItemHandle> {
      // ── Sync validation (throws BEFORE posting). Relay re-validates
      // (defense in depth: an in-process actor bypassing the framework still
      // hits relay checks). ──
      if (!MENU_ITEM_ID_RE.test(opts.id)) {
        throw new Error(`addMenuItem: invalid id "${opts.id}" (allowed: [a-zA-Z0-9_-]{1,64})`);
      }
      if (typeof opts.label !== 'string' || opts.label.length === 0
          || opts.label.length > MENU_ITEM_LABEL_MAX) {
        throw new Error(`addMenuItem: label must be 1..${MENU_ITEM_LABEL_MAX} chars`);
      }
      if (opts.menu !== 'store' && opts.menu !== 'library'
          && opts.menu !== 'community' && opts.menu !== 'profile') {
        throw new Error(`addMenuItem: invalid menu "${opts.menu}"`);
      }
      if (typeof opts.url !== 'string' || opts.url.length > 2048
          || !isUrlSafeForNavigation(opts.url)) {
        throw new Error('addMenuItem: url failed safety check (https, no userinfo/port, ≤2048)');
      }
      if (opts.icon !== undefined
          && (typeof opts.icon !== 'string' || opts.icon.length > MENU_ITEM_ICON_MAX_BYTES)) {
        throw new Error(`addMenuItem: icon too large (>${MENU_ITEM_ICON_MAX_BYTES} bytes)`);
      }

      // Register the registry undo BEFORE awaiting so a framework rollback
      // during the roundtrip still tells the relay to drop the item.
      const undoId = registry.push({
        description: `menu-item:${opts.id}`,
        undo: () => {
          try { ch.post({ kind: 'remove-menu-item', menuItemId: opts.id }); } catch { /* */ }
        },
      });
      try {
        // Shorter timeout than attachPopup/openWindow: a dropped message on a
        // cold relay should surface fast so the caller's retry (installAddFundsMain)
        // re-posts within ~2s instead of ~5s. add-menu-item is idempotent, so a
        // spurious retry is harmless.
        await attachRequest<{ kind: 'menu-item-added'; menuItemId: string }>({
          kind: 'add-menu-item',
          menuItemId: opts.id,
          menu: opts.menu,
          label: opts.label,
          iconSvg: opts.icon,
          url: opts.url,
          variant: opts.variant ?? 'default',
          placement: opts.placement ?? 'top',
        }, MENU_ITEM_ATTACH_TIMEOUT_MS);
      } catch (e) {
        registry.remove(undoId);
        throw e;
      }

      return {
        remove(): void {
          ch.post({ kind: 'remove-menu-item', menuItemId: opts.id });
          registry.remove(undoId);
        },
      };
    },

    addStoreNavButton(opts: StoreNavButtonOptions): StoreNavButtonHandle {
      // Sync validation (throws before touching the DOM), mirrors addMenuItem.
      if (!MENU_ITEM_ID_RE.test(opts.id)) {
        throw new Error(`addStoreNavButton: invalid id "${opts.id}" (allowed: [a-zA-Z0-9_-]{1,64})`);
      }
      if (typeof opts.label !== 'string' || opts.label.length === 0
          || opts.label.length > MENU_ITEM_LABEL_MAX) {
        throw new Error(`addStoreNavButton: label must be 1..${MENU_ITEM_LABEL_MAX} chars`);
      }
      if (opts.icon !== undefined
          && (typeof opts.icon !== 'string' || opts.icon.length > MENU_ITEM_ICON_MAX_BYTES)) {
        throw new Error(`addStoreNavButton: icon too large (>${MENU_ITEM_ICON_MAX_BYTES} bytes)`);
      }
      if (typeof opts.url !== 'string' || opts.url.length > 2048 || !isUrlSafeForNavigation(opts.url)) {
        throw new Error('addStoreNavButton: url failed safety check (https, no userinfo/port, ≤2048)');
      }

      ensureStoreNavStyles();
      const placement = opts.placement ?? 'start';

      const button = document.createElement('button');
      button.id = opts.id;
      button.type = 'button';
      button.setAttribute('data-sb', '1');
      button.setAttribute('data-booster-storenav-btn', '');
      // 'brand' is the default (Figma catalog button is brand green).
      if ((opts.variant ?? 'brand') === 'brand') {
        button.setAttribute('data-booster-variant', 'brand');
      }

      const labelSpan = document.createElement('span');
      labelSpan.className = 'booster-storenav-label';
      labelSpan.textContent = opts.label;
      button.appendChild(labelSpan);

      if (opts.icon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'booster-storenav-icon';
        if (/^data:image\//i.test(opts.icon)) {
          const img = document.createElement('img');
          img.src = opts.icon; img.alt = '';
          iconSpan.appendChild(img);
        } else {
          // SECURITY: sanitise — semi-privileged store origin, third-party Ui.
          const svg = sanitizeIconSvg(opts.icon, document);
          if (svg) iconSpan.appendChild(svg);
          // else: icon rejected by the sanitiser — button still renders label-only.
        }
        button.appendChild(iconSpan);
      }

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isUrlSafeForNavigation(opts.url)) {
          try { window.location.assign(opts.url); } catch { /* best-effort */ }
        }
      });

      let aborted = false;
      let observer: MutationObserver | null = null;
      let observedRow: HTMLElement | null = null;
      let warned = false;
      let threwWarned = false;

      const insert = (row: HTMLElement): void => {
        if (placement === 'end') row.appendChild(button);
        else row.insertBefore(button, row.firstChild);
      };

      // `force` skips the fast-path guard and always re-verifies against
      // findStoreNav(). The high-frequency observer path calls it unforced (O(1)
      // when the button is already placed); the slow interval calls it forced so
      // it keeps re-validating ground truth — self-healing an initial mis-pick
      // (e.g. a transient candidate group during progressive tab rendering, or
      // findStoreNav's tie-break ambiguity) that the guard would otherwise
      // freeze in place for the rest of the page's life.
      const reconcile = (force: boolean): void => {
        if (aborted) return;
        // Fast-path: the button already sits in the current (still-connected)
        // nav row → nothing to do. Keeps the documentElement-subtree observer
        // O(1) against the store page's constant DOM churn — findStoreNav only
        // runs when the button is missing/displaced (first mount, a React
        // re-render that wiped it, a wholesale row replacement) or on a forced
        // (interval) re-validation.
        if (!force && button.isConnected && observedRow && observedRow.isConnected
            && button.parentElement === observedRow) return;
        const row = findStoreNav();
        if (!row) {
          if (!warned) { warned = true; nativeWarn('addStoreNavButton: store nav not found', { id: opts.id }); }
          return;
        }
        warned = false;
        observedRow = row;
        if (!row.contains(button)) insert(row);
      };

      const runReconcile = (force: boolean): void => {
        try { reconcile(force); }
        catch (e) {
          // Latch like `warned`: under the documentElement-subtree observer a
          // persistent throw would otherwise re-warn on every store-page
          // mutation. One diagnostic line is enough signal.
          if (!threwWarned) { threwWarned = true; nativeWarn('addStoreNavButton reconcile threw', { id: opts.id, error: String(e) }); }
        }
      };

      // Insert the button the INSTANT the nav row appears. MutationObserver
      // callbacks run as microtasks BEFORE the browser paints, so the button
      // paints in the SAME frame as the native tabs — no visible pop-in. The
      // store re-injects at document-start on every (full-reload) navigation,
      // where the React nav row renders AFTER our code runs; observing
      // documentElement catches that appearance immediately instead of waiting
      // up to one reconcile tick (the old ~500ms lag). The observer also
      // re-inserts on a React re-render / row replacement; the interval is a
      // forced periodic re-validation (ground-truth safety net).
      observer = new MutationObserver(() => runReconcile(false));
      observer.observe(document.documentElement, { childList: true, subtree: true });
      runReconcile(false);   // instant mount if the row is already present
      const intervalId = setInterval(() => runReconcile(true), STORENAV_RECONCILE_MS);

      const teardown = (): void => {
        aborted = true;
        clearInterval(intervalId);
        if (observer) { try { observer.disconnect(); } catch { /* */ } }
        observer = null; observedRow = null;
        button.remove();
      };

      const undoId = registry.push({ description: `storeNavButton:${opts.id}`, undo: teardown });

      return {
        remove(): void { teardown(); registry.remove(undoId); },
        setLabel(s: string): void { labelSpan.textContent = s; },
      };
    },
  };
}
