// Wire-protocol для BroadcastChannel('sb_cmd') между main shell framework
// и SharedJSContext relay.
//
// Fire-and-forget: show / hide / toggle / postMessage target a pre-allocated
// popup and need no confirmation. Single-RPC (await response): attach-popup
// and navigate. Push user-data: relay broadcasts user-snapshot on every
// relevant change; main shell subscribes and enriches incrementally via
// request-snapshot / get-user-account-settings / get-user-country / get-user-language.

export type RelayChannel = 'sb_cmd';
export const RELAY_CHANNEL: RelayChannel = 'sb_cmd';

// Wire-protocol constraint shared between framework (caller validation in
// ui.ts) and relay (defense-in-depth validation in shared-context.ts).
// Matches the pattern Steam itself uses for its own popup names. Safe to
// interpolate into BC payloads, native window names, and DOM attributes.
export const POPUP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// Defense-in-depth cap on inline HTML payload size for attach-popup, passed
// over the BroadcastChannel to the SharedJSContext relay. This is a backstop
// against a malformed/runaway payload clogging the BC channel — NOT a hard
// CEF/native limit. The HTML is our own build-time-generated popup (trusted),
// and a real popup is a full Svelte app (~260 KB non-minified in dev, much
// smaller minified in prod), so the cap is deliberately generous (2 MB): it
// should only ever trip on a genuinely runaway bug, never on real content.
export const POPUP_HTML_MAX_BYTES = 2 * 1024 * 1024;

// --- Popup attach (one-shot RPC) ---
export interface AttachPopupRequest {
  kind: 'attach-popup';
  requestId: number;
  popupId: string;
  html: string;
  width: number;
  height: number;
  hideOnBlur: boolean;
  // Flag opts (all optional, defaults match Steam-native = STEAM_DROPDOWN_FLAGS = 4538634).
  alwaysOnTop?: boolean;
  nativeBorder?: boolean;
  noTaskbarIcon?: boolean;
  noWindowShadow?: boolean;
  noRoundedCorners?: boolean;
  composited?: boolean;
  transparentParent?: boolean;
  overrideRedirect?: boolean;
}

export interface AttachPopupResponse {
  kind: 'popup-attached' | 'popup-attach-error';
  requestId: number;
  popupId: string;
  error?: string;
}

// --- Popup show/hide/toggle (fire-and-forget) ---
export interface PopupShowRequest {
  kind: 'popup-show';
  popupId: string;
  x: number; // absolute screen X
  y: number; // absolute screen Y
}

export interface PopupHideRequest {
  kind: 'popup-hide';
  popupId: string;
}

export interface PopupToggleRequest {
  kind: 'popup-toggle';
  popupId: string;
  x: number;
  y: number;
}

export interface PopupDestroyRequest {
  kind: 'popup-destroy';
  popupId: string;
}

export interface PopupPostMessageRequest {
  kind: 'popup-postMessage';
  popupId: string;
  data: unknown;
}

// --- Popup events back to main shell ---
export interface PopupMessageEvent {
  kind: 'popup-message';
  popupId: string;
  data: unknown;
}

// Auto-hide on blur — the relay (which runs the polling) emits this so
// callers' on('hide') listeners fire and local visibility tracking stays
// in sync.
export interface PopupHideEvent {
  kind: 'popup-hide-event';
  popupId: string;
}

// --- Navigate (one-shot RPC) ---
export interface NavigateRequest {
  kind: 'navigate';
  requestId: number;
  url: string;
}

export interface NavigateResponse {
  kind: 'navigate-done' | 'navigate-error';
  requestId: number;
  error?: string;
}

// --- Menu item injection into Steam top-nav supernav popups ---
// add-menu-item is a one-shot RPC (await added/error); remove-menu-item is
// fire-and-forget. The item is injected/maintained by the SharedJSContext
// relay (the only context that reaches the supernav popup DOM via
// g_PopupManager); click navigates the main window via MWBM.LoadURL.

/** Which top-nav supernav (context-menu popup) to inject into. Resolved to the
 *  popup's document.title by the relay (MENU_POPUP_TITLE). */
export type SteamMenuName = 'store' | 'library' | 'community' | 'profile';

/** menuItemId charset — reuses POPUP_ID_RE (identical constraints): safe to
 *  interpolate into a DOM id, a `<style>` selector, and a BC payload. */
export const MENU_ITEM_ID_RE = POPUP_ID_RE;
/** Defense-in-depth caps — label + icon cross realms into the popup DOM. */
export const MENU_ITEM_LABEL_MAX = 120;
export const MENU_ITEM_ICON_MAX_BYTES = 16 * 1024;

/** SteamMenuName → the supernav popup's `document.title`. These internal
 *  titles are English/stable even under a localized Steam (verified via live
 *  CDP: Russian menu items, English window titles). */
export const MENU_POPUP_TITLE: Record<SteamMenuName, string> = {
  store: 'Store Supernav',
  library: 'Library Supernav',
  community: 'Community Supernav',
  profile: 'Profile Supernav',
};

export interface AddMenuItemRequest {
  kind: 'add-menu-item';
  requestId: number;
  menuItemId: string;
  menu: SteamMenuName;
  label: string;
  /** Inline SVG / data-uri string, innerHTML'd into the item's icon span
   *  (same trust boundary + detection as HeaderButtonOptions.icon). */
  iconSvg?: string;
  /** https URL opened in the MAIN Steam window on click (MWBM.LoadURL). */
  url: string;
  variant: 'brand' | 'default';
  placement: 'top' | 'bottom';
}

export interface AddMenuItemResponse {
  kind: 'menu-item-added' | 'menu-item-error';
  requestId: number;
  menuItemId: string;
  error?: string;
}

export interface RemoveMenuItemRequest {
  kind: 'remove-menu-item';
  menuItemId: string;
}

// ─────────── User-data push protocol ───────────

export interface UserSnapshotEvent {
  kind: 'user-snapshot';
  snapshot: {
    accountName: string;
    personaName?: string;
    steamId?: string;
    balanceFormatted?: string;
    isLimited?: boolean;
    isOfflineMode?: boolean;
  };
}

export interface RequestSnapshotRequest { kind: 'request-snapshot'; }

export interface GetUserAccountSettingsRequest { kind: 'get-user-account-settings'; requestId: number; }
export interface GetUserAccountSettingsOk      { kind: 'user-account-settings-ok'; requestId: number; email: string | undefined; emailValidated: boolean | undefined; }
export interface GetUserCountryRequest         { kind: 'get-user-country';   requestId: number; }
export interface GetUserCountryOk              { kind: 'user-country-ok';    requestId: number; value: string | undefined; }
export interface GetUserLanguageRequest        { kind: 'get-user-language';  requestId: number; }
export interface GetUserLanguageOk             { kind: 'user-language-ok';   requestId: number; value: string | undefined; }
export interface GetMachineIdRequest { kind: 'get-machine-id'; requestId: number; }
export interface MachineIdOk { kind: 'machine-id-ok'; requestId: number; value: import('../api/api-types').MachineId | undefined; }
export interface GetOwnedGamesRequest { kind: 'get-owned-games'; requestId: number; includePrices: boolean; }
export interface OwnedGamesOk { kind: 'owned-games-ok'; requestId: number; result: import('../api/api-types').OwnedGamesResult; }
export interface GetInventoryRequest { kind: 'get-inventory'; requestId: number; options: { apps?: import('../api/api-types').AppContext[]; maxItemsPerApp?: number; includeIcons?: boolean }; }
export interface InventoryOk { kind: 'inventory-ok'; requestId: number; result: import('../api/api-types').InventoryResult; }
export interface GetAccountLevelRequest { kind: 'get-account-level'; requestId: number; accountId: number | undefined; }
export interface AccountLevelOk { kind: 'account-level-ok'; requestId: number; level: number | undefined; }
export interface GetParentalStateRequest { kind: 'get-parental-state'; requestId: number; }
export interface ParentalStateOk { kind: 'parental-state-ok'; requestId: number; state: import('../api/api-types').ParentalState | undefined; }
export interface GetAvatarRequest { kind: 'get-avatar'; requestId: number; steamId: string; }
export interface AvatarOk { kind: 'avatar-ok'; requestId: number; dataUrl: string | undefined; }

// ─────────── Key activation (one-shot RPC) ───────────
// Carries only {key} inbound and an already-decoded {outcome} | {error}
// outbound — raw response bytes + PII never cross the channel.
export interface ActivateProductKeyRequest { kind: 'activate-product-key'; requestId: number; key: string; }
export interface ActivateProductKeyOk      { kind: 'activate-product-key-ok'; requestId: number; outcome: import('../api/api-types').ActivateOutcome; }
export interface ActivateProductKeyError   { kind: 'activate-product-key-error'; requestId: number; error: string; }

// ─────────── Toggle gate (relay-side) ───────────

// Relay broadcasts popup-show-event when a popup actually transitions to
// visible (mirrors PopupHideEvent). Main shell uses this to keep local
// visibility tracking and fire on('show') listeners.
export interface PopupShowEvent { kind: 'popup-show-event'; popupId: string; }

// ─────────── openWindow protocol ───────────

/** Cap inline HTML for openWindow (mirrors POPUP_HTML_MAX_BYTES — generous
 *  2 MB backstop, not a hard limit; see POPUP_HTML_MAX_BYTES rationale). */
export const OPEN_WINDOW_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** Cap for openWindow message payloads, both directions. Mirrors BUS_MAX_BYTES. */
export const WINDOW_MESSAGE_MAX_BYTES = 16 * 1024;
/** Embed-handshake protocol version (sb:embed / sb:ready envelope). */
export const SB_EMBED_V = 1;

// MainShell → SharedJSContext relay (one-shot RPC).
export interface OpenWindowRequest {
  kind: 'open-window';
  requestId: number;
  windowId: string;
  title: string;
  url?: string;
  html?: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  noTaskbarIcon: boolean;
  alwaysOnTop: boolean;
  composited: boolean;
  centerOnMain: boolean;
  iframeBackground?: string;
  /** Дополнительные origin'ы, которым обёртка отвечает на sb:ready
   *  (помимо origin стартового url). Валидируется relay-side. */
  embedOrigins?: string[];
}

export interface OpenWindowResponse {
  kind: 'window-opened' | 'window-open-error';
  requestId: number;
  windowId: string;
  effectiveWidth?: number;
  effectiveHeight?: number;
  error?: string;
}

// MainShell → relay (fire-and-forget).
export interface WindowShowRequest    { kind: 'window-show';     windowId: string; }
export interface WindowHideRequest    { kind: 'window-hide';     windowId: string; }
export interface WindowCloseRequest   { kind: 'window-close';    windowId: string; }
export interface WindowBringRequest   { kind: 'window-bring';    windowId: string; }
export interface WindowPostMessageRequest { kind: 'window-postMessage'; windowId: string; data: unknown; }

// MainShell → popup wrapper (NOT via relay — wrapper subscribes BC directly).
export interface WindowSetTitleRequest{ kind: 'window-set-title'; windowId: string; title: string; }

// Relay → MainShell (events).
export interface WindowShowEvent    { kind: 'window-show-event';  windowId: string; }
export interface WindowHideEvent    { kind: 'window-hide-event';  windowId: string; }
export interface WindowCloseEvent   { kind: 'window-close-event'; windowId: string; reason: 'caller'|'user'|'crash'|'teardown'; }
export interface WindowMessageEvent { kind: 'window-message';     windowId: string; data: unknown; }

// Wrapper-HTML → relay (user clicked X).
export interface WindowUserCloseEvent { kind: 'window-user-close'; windowId: string; }

export type MainToShared =
  | AttachPopupRequest
  | PopupShowRequest
  | PopupHideRequest
  | PopupToggleRequest
  | PopupDestroyRequest
  | PopupPostMessageRequest
  | NavigateRequest
  | AddMenuItemRequest
  | RemoveMenuItemRequest
  | RequestSnapshotRequest
  | GetUserAccountSettingsRequest
  | GetUserCountryRequest
  | GetUserLanguageRequest
  | GetMachineIdRequest
  | OpenWindowRequest
  | WindowShowRequest
  | WindowHideRequest
  | WindowCloseRequest
  | WindowBringRequest
  | WindowPostMessageRequest
  | ActivateProductKeyRequest
  | GetOwnedGamesRequest
  | GetInventoryRequest
  | GetAccountLevelRequest
  | GetParentalStateRequest
  | GetAvatarRequest;

export type SharedToMain =
  | AttachPopupResponse
  | PopupMessageEvent
  | PopupHideEvent
  | PopupShowEvent
  | NavigateResponse
  | AddMenuItemResponse
  | UserSnapshotEvent
  | GetUserAccountSettingsOk
  | GetUserCountryOk
  | GetUserLanguageOk
  | MachineIdOk
  | OpenWindowResponse
  | WindowShowEvent
  | WindowHideEvent
  | WindowCloseEvent
  | WindowMessageEvent
  | WindowUserCloseEvent
  | ActivateProductKeyOk
  | ActivateProductKeyError
  | OwnedGamesOk
  | InventoryOk
  | AccountLevelOk
  | ParentalStateOk
  | AvatarOk;

export type RelayMessage = MainToShared | SharedToMain;

// ─────────── external-window protocol ───────────

export type ExternalWindowOpenRequest = {
  kind: 'external-window-open';
  requestId: number;
  id: string;
  url: string;
  /** Если задан — relay шлёт injectTabTitleOverride bridge call. */
  title?: string;
  /** Three-state native-title control:
   *   string — слать setNativeWindowTitle с этой строкой;
   *   null   — explicit opt-out (controller сбрасывает на default);
   *   absent — fallback на title (если есть). */
  taskbarTitle?: string | null;
};

export type ExternalWindowOpenReply =
  | { kind: 'external-window-open-reply'; requestId: number; ok: true }
  | { kind: 'external-window-open-reply'; requestId: number; ok: false; error: string };

export type ExternalWindowSetUrlRequest = {
  kind: 'external-window-set-url';
  id: string;
  url: string;
};

export type ExternalWindowCloseRequest = {
  kind: 'external-window-close';
  id: string;
};

export type ExternalWindowCloseEvent = {
  kind: 'external-window-close-event';
  id: string;
};

export type ExternalWindowStateEvent = {
  kind: 'external-window-state';
  shellRequestIds: number[];
  /** title — three states:
   *   string — controller posts setNativeWindowTitle с этой строкой;
   *   null   — explicit opt-out: controller resets к default;
   *   undefined / absent — no preference (controller игнорирует). */
  ourRequestIds: Array<{ id: string; reqId: number; title?: string | null }>;
  activeRequestId: number;
  activeIsOurs: boolean;
  activeOurId: string | null;
  /** Same three-state semantics. Property absent = no preference. */
  activeTitle?: string | null;
  manifestHints: string[];
};

export type ExternalWindowNativeTitleRequest = {
  kind: 'external-window-native-title-request';
  title: string;
  geometry: { x: number; y: number; w: number; h: number };
};

export type ExternalWindowStateRequest = {
  kind: 'external-window-state-request';
};
