import type { ScopeApi } from './scope';

/**
 * Steam V8 context kinds where framework + plugins may run.
 *
 *   - Main          : main Steam window (was 'main-shell')
 *   - Shared        : SharedJSContext (global Steam SDK access)
 *   - TabbedBrowser : Steam's tabbed browser windows (news, payment)
 *   - Web           : Steam web pages in embedded browser (store, community, help)
 */
export const ContextKind = {
  Main:           'main',
  Shared:         'shared',
  TabbedBrowser:  'tabbedBrowser',
  Web:            'web',
} as const;
export type ContextKind = typeof ContextKind[keyof typeof ContextKind];

// `before-profile` (default) — slot the button between the bell-icon
// "Notifications" item and the profile+balance widget. Matches the
// position user requested ("после нотификаций и до профиля") and works
// with Steam toolbar layouts where the profile is followed by zero or
// more right-edge widgets we shouldn't precede.
//
// `before-notifications`, `after-profile`, `end` retained for callers
// that pin to alternative anchors. `before-notifications` falls back
// to inserting before toolbar.lastElementChild when no explicit
// notifications anchor is found.
export type HeaderButtonPlacement =
  | 'before-profile'
  | 'before-notifications'
  | 'after-profile'
  | 'end';

export interface HeaderButtonOptions {
  id: string;
  label: string;

  /** Optional inline-HTML/SVG/data-uri string rendered as an icon next
   *  to the label (in a <span class="booster-toolbar-icon"> after the label).
   *
   *  Detection:
   *    - starts with 'data:image/' → wrapped in <img src="...">
   *    - otherwise (e.g. '<svg ...>') → inserted as-is via innerHTML
   *
   *  @security This string is INSERTED VIA innerHTML. Pass build-time
   *  constants only (e.g. base64-inlined PNG, bundled SVG string).
   *  Never pass values derived from network/manifest/user input.
   *  Framework does NOT sanitise (validation cost > benefit; trust
   *  boundary is "framework trusts plugin code"). */
  icon?: string;

  tooltip?: string;
  placement?: HeaderButtonPlacement;  // default 'before-profile'

  /** Visual variant. 'default' (default) — Steam-native bell-style
   *  (gray bg, secondary text). 'brand' — SteamBalance brand-color
   *  (#34a37b green bg, white uppercase text, small letter-spacing). */
  variant?: 'default' | 'brand';

  /** EITHER onClick OR togglePopup — взаимоисключающие. addHeaderButton
   *  throws Error синхронно если оба заданы или оба пропущены. */
  onClick?: (ctx: { rect: DOMRect }) => void | Promise<void>;
  togglePopup?: AttachedPopupHandle;
}

export interface HeaderButtonHandle {
  remove(): void;
  setLabel(s: string): void;
  setEnabled(on: boolean): void;
  /** Live element rect, in CSS pixels relative to the main shell viewport. */
  getRect(): DOMRect;
}

export interface AttachedPopupOptions {
  /** popupId, [a-zA-Z0-9_-]{1,64}. Used as native window name + BC key. */
  id: string;
  /** Inline HTML written via document.write into popup window
   *  (origin = opener's loopback; BC works). Capped at POPUP_HTML_MAX_BYTES. */
  html: string;
  width: number;
  height?: number;          // default 200
  hideOnBlur?: boolean;     // default true

  // ── eCreationFlags as named booleans ──
  // Defaults match Steam-native dropdown flag set 4538634.
  // Установлены чтобы голый attachPopup({id, html, width}) сразу давал
  // правильный native look без явного указания флагов.

  /** Stays above other windows including main shell content.
   *  Default false (как Steam Notifications). */
  alwaysOnTop?: boolean;
  /** Native 1px CEF border (bit 65536). Default true. */
  nativeBorder?: boolean;
  /** Hide from Windows taskbar. Default true. */
  noTaskbarIcon?: boolean;
  /** Disable Windows drop-shadow. Default true. */
  noWindowShadow?: boolean;
  /** Square corners (no Win11 rounding). Default true. */
  noRoundedCorners?: boolean;
  /** GPU compositing. Default true. */
  composited?: boolean;
  /** Transparent parent linkage. Default true. */
  transparentParent?: boolean;
  /** X11 OverrideRedirect. На Windows no-op — оставлено как опция
   *  на случай Linux Steam в будущем. Default false. */
  overrideRedirect?: boolean;
}

export interface AttachedPopupHandle {
  /** Effective width / height — i.e. **after** clamping
   *    width:  max(40, min(opts.width  | 0, 1200))
   *    height: max(40, min(opts.height | 0, 800))
   *  Используется addHeaderButton.togglePopup для compute screen-coords.
   *  Caller всегда видит реальный размер native окна, не raw input. */
  readonly width: number;
  readonly height: number;

  /** Toggle с timestamp-gate (250мс relay-side). Если предыдущий state-change
   *  произошёл < 250мс назад — call consume-ится без эффекта. */
  toggle(at: { x: number; y: number }): void;

  /** Show / hide — RAW. Bypass gate. Используй когда явно хочешь
   *  показать/скрыть программно (без button-click race). */
  show(at: { x: number; y: number }): void;
  hide(): void;

  postMessage(data: unknown): void;
  on(event: 'message' | 'show' | 'hide', cb: (data?: unknown) => void): () => void;
  isVisible(): boolean;
  destroy(): void;
}

export interface OpenWindowOptions {
  /** [a-zA-Z0-9_-]{1,64}. */
  id: string;
  /** Required, рендерится в HTML title bar. */
  title: string;
  /** Mutex с html. Sync throw otherwise. */
  url?: string;
  html?: string;
  width: number;
  height: number;
  /** Default 320 / 240. Effective floor 200 / 150. */
  minWidth?: number;
  minHeight?: number;
  // Defaults match STEAM_MODAL_FLAGS = 3 (HIDDEN | RESIZABLE).
  resizable?: boolean;
  noTaskbarIcon?: boolean;
  alwaysOnTop?: boolean;
  composited?: boolean;
  /** Default true. */
  centerOnMain?: boolean;
  /** Background colour shown around the iframe (visible only when the
   *  embedded content's natural width is narrower than the popup —
   *  classic case is a chat widget at 360px inside a 500px window).
   *  Default `'#fff'` suits chat embeds and most light-themed pages;
   *  pass a darker tone (e.g. `'#1b1d23'`) for dark-themed embeds.
   *  CSS-color string passed through unchanged into the wrapper's
   *  `<style>` block — caller is trusted (matches the trust boundary
   *  on `html` content). */
  iframeBackground?: string;
  /** Доп. origin'ы (помимо origin стартового `url`), которым окно
   *  отвечает на embed-рукопожатие (`sb:ready`) при навигации страницы
   *  на эти origin'ы. По умолчанию — только origin стартового `url`.
   *  Каждый — точный https-origin (без path/порта/userinfo); relay
   *  валидирует и ограничивает ≤8. Только url-режим. */
  embedOrigins?: string[];
}

export interface OpenWindowHandle {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  show(): void;
  hide(): void;
  close(): void;
  bringToFront(): void;
  setTitle(s: string): void;
  isVisible(): boolean;
  /** Послать сообщение содержимому окна. url-режим: доставляется в
   *  cross-origin iframe через window.postMessage (мост в обёртке);
   *  payload ≤16 КБ, иначе drop. Слать ТОЛЬКО после получения `sb:ready`
   *  от страницы (см. docs/embed-bridge.md). */
  postMessage(data: unknown): void;
  on(event: 'show' | 'hide' | 'close' | 'message',
     cb: (data?: unknown) => void): () => void;
}

export interface OpenExternalWindowOptions {
  /** Уникальный ID, [a-zA-Z0-9_-]{1,64}. Повторный openExternalWindow
   *  с тем же id, пока окно открыто, отвергается relay-side. Используется
   *  для маршрутизации событий close. */
  id: string;
  /** External URL. Validation: только https://, ASCII-strict, без
   *  userinfo, без явного port, длина ≤2048. */
  url: string;
  /** Заголовок для React TitleBar внутри окна Steam tabbed shell.
   *  Применяется через `Page.addScriptToEvaluateOnNewDocument` +
   *  `Runtime.evaluate` к content-target'у — скрипт перехватывает
   *  document.title и не даёт странице переписать. Распространяется
   *  автоматически на все redirect-цели (Paypalych → банк → СБП),
   *  пока окно живо.
   *
   *  Если undefined — React TitleBar показывает оригинальный <title>
   *  страницы. Если задан — длина 1..200 UTF-16 code units.
   *
   *  Override применяется ВСЕГДА когда title задан — не opt-in feature,
   *  а универсальный механизм sb.ui.openExternalWindow. */
  title?: string;

  /** Заголовок для Windows native title-bar / taskbar. Контролируется
   *  независимо от `title`:
   *
   *    - `undefined` (default): fallback на `title` если задан, иначе
   *                  не подменяется (= что прислал сайт).
   *    - `string`:   `setNativeWindowTitle` вызывается с этой строкой.
   *    - `null`:     explicit opt-out — не подменяем; Steam-default
   *                  ("Steam — браузер") активно восстанавливается если
   *                  ранее переопределяли.
   *
   *  Длина если string: 1..200 UTF-16 code units. */
  taskbarTitle?: string | null;
}

export interface OpenExternalWindowHandle {
  readonly id: string;
  /** Атомарная замена URL: relay делает Add+Remove. Sync throws на
   *  invalid URL. Silent no-op если handle уже close'нут. */
  setUrl(url: string): void;
  /** Закрыть нашу вкладку (окно закроется, если других нет). */
  close(): void;
  /** Подписка на close. Срабатывает один раз. Возвращает unsubscribe. */
  on(event: 'close', cb: () => void): () => void;
}

/** Steam desktop-client top-nav dropdown ("supernav") to inject an item into.
 *  Resolved to the popup's `document.title` by the relay. */
export type SteamMenu = 'store' | 'library' | 'community' | 'profile';

export interface MenuItemOptions {
  /** id, [a-zA-Z0-9_-]{1,64}. Auto-prefixed with the plugin id; used as the
   *  injected DOM id + `<style>` selector + relay routing key. */
  id: string;
  /** Which top-nav supernav dropdown to inject into. */
  menu: SteamMenu;
  /** Item text. Rendered via textContent. Capped at 120 chars. */
  label: string;
  /** Optional inline-SVG / data-uri icon, placed at the RIGHT of the label.
   *
   *  Detection: `data:image/...` → `<img src>`; otherwise treated as inline
   *  SVG. Inline SVG using `fill="currentColor"` inherits the item's text
   *  colour (so it recolours on hover for free).
   *
   *  @security Inserted into the privileged SharedJSContext popup DOM. The
   *  relay SANITISES it (SVG tag/attribute allowlist; `on*`/script/external
   *  refs stripped) — unlike HeaderButtonOptions.icon — because Capability.Ui
   *  is also granted to third-party approved plugins. Still: pass build-time
   *  constants, not network/user input. */
  icon?: string;
  /** https URL opened in the MAIN Steam window on click (via
   *  MainWindowBrowserManager.LoadURL). Validated https / no-userinfo /
   *  no-port, length ≤2048. */
  url: string;
  /** 'brand' — SteamBalance treatment: idle bg #34A37B33, text+icon #93E0AD;
   *  hover reverts to the native Steam item look. 'default' (default) — looks
   *  exactly like a native Steam item, just with the optional icon. */
  variant?: 'brand' | 'default';
  /** 'top' (default) inserts at the top of the menu; 'bottom' appends. */
  placement?: 'top' | 'bottom';
}

export interface MenuItemHandle {
  /** Remove the item (and stop maintaining it). Fire-and-forget. */
  remove(): void;
}

export interface StoreNavButtonOptions {
  /** DOM id AND the [data-booster-storenav-btn] style anchor. Charset
   *  MENU_ITEM_ID_RE ([a-zA-Z0-9_-]{1,64}); validated (throws) because it is
   *  used inside a CSS attribute selector. */
  id: string;
  /** Item text. Rendered via textContent. Capped at 120 chars. */
  label: string;
  /** Optional inline SVG string or data:image/* URI, rendered after the label.
   *  SVG is SANITISED (allowlist tags/attrs) — the store page is a
   *  semi-privileged origin and Capability.Ui is reachable by third-party
   *  approved plugins (unlike addHeaderButton, which trusts the plugin in the
   *  main shell). data:image/* → <img>. Capped at 16 KB. */
  icon?: string;
  /** Navigation target. Must pass isUrlSafeForNavigation (https, no
   *  userinfo/port, ≤2048) — validated (throws). Click → location.assign in
   *  the current store tab (MainWindowBrowserManager is unreachable from the
   *  store realm). */
  url: string;
  /** Visual variant. Default 'brand' (SteamBalance green pill). */
  variant?: 'default' | 'brand';
  /** 'start' (default) = before the first tab («Просмотр»); 'end' = after the
   *  last tab. */
  placement?: 'start' | 'end';
}

export interface StoreNavButtonHandle {
  remove(): void;
  setLabel(s: string): void;
}

/** Where the button lands relative to the supernav's `<НИК>` (profile) tab. */
export type SuperNavButtonPlacement = 'after-profile' | 'end';

export interface SuperNavButtonOptions {
  /** DOM id AND the `[data-booster-supernav-btn]` style anchor. Charset
   *  MENU_ITEM_ID_RE ([a-zA-Z0-9_-]{1,64}); validated (throws) because it is
   *  used inside a CSS attribute selector. */
  id: string;
  /** Button text. Rendered via `textContent`; the stylesheet uppercases it.
   *  1..120 chars — validated (throws). */
  label: string;
  /** Optional inline SVG string or `data:image/*` URI, rendered next to the
   *  label. SVG is SANITISED (allowlist tags/attrs) — the supernav lives in
   *  the semi-privileged Main shell and `Capability.Ui` is reachable by
   *  third-party approved plugins. `data:image/*` → `<img>`. Capped at 16 KB. */
  icon?: string;
  /** `'after-profile'` (default) inserts right after the `<НИК>` profile tab;
   *  `'end'` appends as the last child of the supernav row. */
  placement?: SuperNavButtonPlacement;
  /** Visual variant. Default `'brand'` (SteamBalance green pill). */
  variant?: 'default' | 'brand';
  /** Click handler — unlike `addStoreNavButton` (which navigates to a `url`),
   *  the supernav button is onClick-only. Receives the button's live
   *  `DOMRect` so the handler can anchor its own UI. A re-entrant click while
   *  a returned promise is still pending is ignored (busy guard). */
  onClick: (ctx: { rect: DOMRect }) => void | Promise<void>;
}

export interface SuperNavButtonHandle {
  /** Remove the button, stop the reconcile loop, disconnect the observer,
   *  drop the user-snapshot listener, and clear the error timer. Also fires
   *  automatically on `lifecycle.rollbackAll()`. */
  remove(): void;
  /** Replace the label `textContent` in place, without recreating the node. */
  setLabel(s: string): void;
  /** Enable / disable the button. Disabled ⇒ `aria-disabled="true"`, clicks
   *  are ignored. */
  setEnabled(on: boolean): void;
  /** Toggle the busy spinner. While loading the button shows a spinner, reads
   *  as disabled (`aria-disabled`), and ignores clicks. */
  setLoading(on: boolean): void;
  /** Flash the button red for ~1s to signal a failed action, then revert. */
  flashError(): void;
  /** Live `DOMRect` of the button (via `getBoundingClientRect`). */
  getRect(): DOMRect;
}

export interface UiApi {
  addHeaderButton(opts: HeaderButtonOptions): HeaderButtonHandle;
  /** Allocate a native dropdown popup once at startup and toggle it on
   *  demand. Resolves once the relay has created and hidden the window. */
  attachPopup(opts: AttachedPopupOptions): Promise<AttachedPopupHandle>;
  /** Steam-native window with custom HTML title bar + close + iframe.
   *  See framework/README.md § sb.ui.openWindow. */
  openWindow(opts: OpenWindowOptions): Promise<OpenWindowHandle>;
  openExternalWindow(opts: OpenExternalWindowOptions): Promise<OpenExternalWindowHandle>;
  /** Inject a custom item into a Steam desktop-client top-nav dropdown
   *  (МАГАЗИН / БИБЛИОТЕКА / …). The SharedJSContext relay does the DOM work
   *  and keeps the item alive across menu open/close and framework re-inject;
   *  click navigates the main window to `opts.url`. Resolves once the intent
   *  is registered with the relay (NOT once the DOM node exists — the popup
   *  may be closed). Requires Capability.Ui. */
  addMenuItem(opts: MenuItemOptions): Promise<MenuItemHandle>;
  /** Inject a persistent button into the Steam store top-nav bar (the row of
   *  «Просмотр / Рекомендации / Категории …» tabs). Web context only; survives
   *  React re-renders + Steam rebuilds via a structural anchor + reconcile.
   *  Throws synchronously on invalid id, label, icon, or url. */
  addStoreNavButton(opts: StoreNavButtonOptions): StoreNavButtonHandle;
  /** Inject a persistent button into the Steam CLIENT supernav (the top
   *  main-nav row «Магазин / Библиотека / Сообщество / <НИК>»), anchored right
   *  after the `<НИК>` profile tab. Runs direct-DOM in the Main shell (no relay
   *  round-trip → synchronous). The tab is matched structurally by persona OR
   *  account name learned from the shared `user-snapshot` relay event, so it
   *  self-heals across Steam rebuilds and account switches. Unlike
   *  `addStoreNavButton`, it is onClick-only (no navigation `url`) and exposes
   *  loading / error / enabled states on the handle. Throws synchronously on
   *  invalid id, label, or icon. Requires Capability.Ui. */
  addSuperNavButton(opts: SuperNavButtonOptions): SuperNavButtonHandle;
}

export interface SteamUser {
  // ── sync core (гарантированы при non-null SteamUser) ──
  /** Login (Steam account name). Always present. */
  readonly accountName: string;

  // ── sync optional (могут отсутствовать в snapshot) ──
  /** Steam display name. */
  readonly personaName?: string;
  /** Decimal SteamID64. */
  readonly steamId?: string;
  /** 32-bit account id (steamId64 − 76561197960265728). Present whenever steamId
   *  is. Derived locally (BigInt) from steamId — no relay round-trip. */
  readonly accountId?: number;
  /** ISO 4217 — derived from balanceFormatted. undefined если баланс пуст. */
  readonly currency?: string;
  /** Numeric balance — parsed из localized строки. */
  readonly balance?: number;
  /** Localized balance строка как Steam отображает (e.g. "2 177,35₸"). */
  readonly balanceFormatted?: string;
  /** Limited-account flag. */
  readonly isLimited?: boolean;
  /** Offline-mode flag. */
  readonly isOfflineMode?: boolean;

  // ── async per-field getters (cached on relay side) ──
  /** Email из GetAccountSettings.
   *  - Каждый вызов посылает BC roundtrip; relay-сторона дедуплицирует
   *    SteamClient.GetAccountSettings call'ы (cache hit ≠ sync resolve).
   *  - Cache invalidates на смену accountName (relay-сторона).
   *  - Resolves к undefined если Steam не вернул email или произошёл timeout.
   *  - Promise не reject'ит-ся (resolves к undefined даже на bridge-fail). */
  email(): Promise<string | undefined>;
  /** Флаг подтверждённого email.
   *  - Каждый вызов посылает BC roundtrip; relay-сторона дедуплицирует
   *    SteamClient.GetAccountSettings call'ы (cache hit ≠ sync resolve).
   *  - Cache invalidates на смену accountName (relay-сторона).
   *  - Resolves к undefined если Steam не вернул значение или произошёл timeout.
   *  - Promise не reject'ит-ся (resolves к undefined даже на bridge-fail). */
  emailValidated(): Promise<boolean | undefined>;
  /** ISO 3166-1 alpha-2 — Steam-derived из IP.
   *  - Каждый вызов посылает BC roundtrip; relay-сторона дедуплицирует
   *    SteamClient call'ы (cache hit ≠ sync resolve).
   *  - Cache invalidates на смену accountName (relay-сторона).
   *  - Resolves к undefined если Steam не вернул значение или произошёл timeout.
   *  - Promise не reject'ит-ся (resolves к undefined даже на bridge-fail). */
  ipCountry(): Promise<string | undefined>;
  /** Steam UI language (lowercase, e.g. 'russian').
   *  - Каждый вызов посылает BC roundtrip; relay-сторона дедуплицирует
   *    SteamClient call'ы (cache hit ≠ sync resolve).
   *  - Cache invalidates на смену accountName (relay-сторона).
   *  - Resolves к undefined если Steam не вернул значение или произошёл timeout.
   *  - Promise не reject'ит-ся (resolves к undefined даже на bridge-fail). */
  language(): Promise<string | undefined>;
}

export interface MachineId { bb3: string; ff2: string; b3b: string; }

/** Current store price for one app, from StoreItemCache (account wallet currency,
 *  minor units = value÷100). Absent fields ⇒ unknown; isFree ⇒ value 0. */
export interface GamePrice {
  readonly isFree: boolean;
  readonly unavailable?: boolean;       // delisted / not on store
  readonly regionRestricted?: boolean;  // unavailable in account region
  readonly finalMinor?: number;         // current price, minor units
  readonly originalMinor?: number;      // pre-discount price, minor units
  readonly discountPct?: number;
  readonly formattedFinal?: string;     // "1 300,00₸"
  readonly formattedOriginal?: string;
}

/** One owned app from collectionStore (library list). All times are unix seconds. */
export interface OwnedGame {
  readonly appid: number;
  readonly name: string;
  readonly appType: number;
  readonly playtimeForeverMinutes: number;
  readonly playtimeTwoWeeksMinutes?: number;
  /** Purchase time. NOTE: free-license re-grants (e.g. CS2/HL2) can reset this. */
  readonly purchasedAt?: number;
  readonly releaseAt?: number;
  readonly lastPlayedAt?: number;
  readonly metacritic?: number;
  readonly sizeOnDiskBytes?: number;
  /** Present only when getOwnedGames({includePrices:true}). */
  readonly price?: GamePrice;
}

export interface OwnedGamesResult {
  readonly games: OwnedGame[];
  readonly pricesIncluded: boolean;
  /** Account wallet currency (ISO-4217 when derivable). Account-wide. */
  readonly currency?: string;
  /** false if collectionStore wasn't populated in time. */
  readonly ready: boolean;
}

/** One (app, context) inventory partition, e.g. {appid: 730, contextid: '2'}.
 *  `contextid` is a string — Steam context ids exceed Number.MAX_SAFE_INTEGER. */
export interface AppContext {
  readonly appid: number;
  readonly contextid: string;
}

/** One inventory asset, merged with its class/instance description. Slim by
 *  default — `iconUrl` is populated only when getInventory({includeIcons:true}). */
export interface InventoryItem {
  readonly appid: number;
  readonly contextid: string;
  readonly assetid: string;
  readonly classid: string;
  readonly instanceid: string;
  readonly amount: number;
  readonly marketHashName?: string;
  readonly marketName?: string;
  readonly name?: string;
  readonly type?: string;
  readonly marketable: boolean;
  readonly tradable: boolean;
  readonly marketFeeApp?: number;
  /** Steam economy icon path/hash fragment (relative, NOT a full URL).
   *  Present only when includeIcons. To construct a usable image URL prepend
   *  the community CDN base:
   *  `https://community.cloudflare.steamstatic.com/economy/image/<iconUrl>` */
  readonly iconUrl?: string;
}

/** Per-(app, context) fetch outcome — lets callers see partial failures
 *  without losing the items that did come back from other apps. */
export interface InventoryAppResult {
  readonly appid: number;
  readonly contextid: string;
  /** total_inventory_count reported by Steam (may exceed `fetched` if truncated). */
  readonly totalCount?: number;
  readonly fetched: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface InventoryResult {
  readonly items: InventoryItem[];
  readonly perApp: InventoryAppResult[];
  /** true if any app failed OR any app was truncated at maxItemsPerApp. */
  readonly partial: boolean;
}

export interface SteamApi {
  openUrl(url: string): Promise<void>;

  /** Sync read из framework cache (populated by relay broadcast).
   *  Returns null только в cold-start окне ~100мс после framework boot,
   *  либо после rollback (cache cleared). Caller может либо подождать
   *  через onUserChange, либо просто proceed без user data. */
  getCurrentUser(): SteamUser | null;

  /** Returns user as soon as available. If cold-start (cache empty),
   *  awaits first snapshot. Never resolves if no snapshot ever arrives
   *  (никогда не залогиненный Steam) — caller wraps в timeout если нужно.
   *  Rejects with Error('framework rolled back') if lifecycle.rollbackAll()
   *  runs while the Promise is pending. */
  getCurrentUserAsync(): Promise<SteamUser>;

  /** Subscribe to user-data updates. cb fires:
   *    - immediately if cachedUser != null (initial state)
   *    - on every relay-pushed snapshot diff
   *  After framework rollback the listener is silently dropped (no final
   *  null callback fires). Returns unsubscribe. */
  onUserChange(cb: (user: SteamUser | null) => void): () => void;

  /** Страна магазина аккаунта (ISO 3166-1 alpha-2, напр. 'KZ'). Источник —
   *  страница /account/ Steam, добывается невидимо из store-контекста и
   *  персистится нативно (переживает реинжект и рестарт EXE). Ключ — steamId
   *  текущего пользователя.
   *  - undefined, если ещё не добыта (новый аккаунт до первого захода в Store),
   *    после смены аккаунта до повторного захвата, либо при сбое bridge.
   *  - Никогда не reject'ит. Gated под Capability.Steam (как весь sb.steam). */
  getStoreCountry(): Promise<string | undefined>;

  /** Hardware-derived machine identifier triple from Steam's Auth.GetMachineID().
   *  Returns {bb3, ff2, b3b} or undefined if unavailable. Never rejects.
   *  Gated under Capability.Steam. Values are never logged. */
  getMachineId(): Promise<MachineId | undefined>;

  /** Owned-games library (collectionStore) with rich metadata and, optionally,
   *  current store prices (account currency) via the client's own GetItems.
   *  Ban-safe, client-side. Never rejects; ready=false if the library wasn't
   *  populated. Gated under Capability.Steam. */
  getOwnedGames(options?: { includePrices?: boolean }): Promise<OwnedGamesResult>;

  /** The logged-in user's own tradable inventory (items + market hash names),
   *  complete even when the public inventory is private — read over the client's
   *  authenticated CM (Econ.GetInventoryItemsWithDescriptions). Item PRICES are
   *  out of scope (backend). Ban-safe, on-demand. Never rejects. Gated under
   *  Capability.Steam. */
  getInventory(options?: {
    apps?: AppContext[]; maxItemsPerApp?: number; includeIcons?: boolean;
  }): Promise<InventoryResult>;

  /** Steam account XP level — fetched relay-side via CM (Player.GetGameBadgeLevels)
   *  with a miniprofile fallback. Returns undefined if both paths are unavailable.
   *  Never rejects. Gated under Capability.Steam. */
  getAccountLevel(): Promise<number | undefined>;
}

/** One product granted by a successful key activation. */
export interface ActivatedProduct { packageId: number; name: string }

export type ActivateErrorCode =
  | 'already_activated'         // EPurchaseResultDetail 15 DuplicateActivationCode
  | 'already_owned'             // 9  AlreadyPurchased
  | 'invalid_key'               // 14 BadActivationCode
  | 'region_locked'             // 13 RestrictedCountry
  | 'requires_base_game'        // 24 DoesNotOwnRequiredApp
  | 'rate_limited'              // 53 RateLimited
  | 'cannot_redeem_from_client' // 50 CannotRedeemCodeFromClient
  | 'account_locked'            // 44 AccountLocked
  | 'unavailable';              // any other detail / eresult=Fail

export type ActivateOutcome =
  | { ok: true;  products: ActivatedProduct[]; transactionId: string }
  | {
      ok: false;
      code: ActivateErrorCode;
      /** Raw Steam `EPurchaseResultDetail` — see {@link PurchaseResultDetail}.
       *  Typed `number` (not the const) because Steam may return codes beyond
       *  the enumerated set; those collapse to `code: 'unavailable'`. */
      resultDetail: number;
      message: string;
    };

/**
 * Steam's `EPurchaseResultDetail` codes that `Store.RegisterCDKey` can surface
 * in `ActivateOutcome.resultDetail`. NON-EXHAUSTIVE — Steam defines ~70 values
 * and may return ones not listed here; `resultDetail` stays `number` so unknown
 * codes pass through (and map to `code: 'unavailable'`). The trailing arrows
 * show which `ActivateErrorCode` each known value maps to.
 */
export const PurchaseResultDetail = {
  NoDetail: 0,                    // success (ok: true)
  InsufficientFunds: 2,
  ContactSupport: 3,
  Timeout: 4,
  InvalidPackage: 5,
  InvalidData: 7,
  OthersInProgress: 8,
  AlreadyPurchased: 9,            // → already_owned
  RestrictedCountry: 13,          // → region_locked
  BadActivationCode: 14,          // → invalid_key
  DuplicateActivationCode: 15,    // → already_activated
  UseOtherPaymentMethod: 16,
  InvalidAccount: 22,
  DoesNotOwnRequiredApp: 24,      // → requires_base_game
  Expired: 33,
  TransactionExpired: 34,
  AccountLocked: 44,              // → account_locked
  CannotRedeemCodeFromClient: 50, // → cannot_redeem_from_client
  RateLimited: 53,                // → rate_limited
  OwnsExcludedApp: 54,
  POSACodeNotActivated: 58,
  GiftAlreadyOwned: 70,
} as const;
export type PurchaseResultDetail = typeof PurchaseResultDetail[keyof typeof PurchaseResultDetail];

export interface KeysApi {
  /**
   * Activates a Steam product key (same as "Игры → Активировать в Steam").
   * Resolves with a domain outcome (success OR a business failure). Throws
   * ONLY for a bad argument or a transport failure (no connection / timeout).
   * A successful call CONSUMES the key — never auto-retried.
   */
  activate(productKey: string): Promise<ActivateOutcome>;
}

/** Native-proxied HTTPS to one of the plugin's signed `allowedHosts`.
 *  Bypasses page CSP/CORS via the native injector. Gated under Capability.Net. */
export interface NetApi {
  /** Rejects on host-not-allowed, missing Capability.Net, size-cap exceeded,
   *  or transport/TLS failure. Does NOT follow redirects (a 3xx is returned
   *  verbatim). `url` must be https and its host must be in the plugin's
   *  manifest `allowedHosts`. Identity headers (x-booster*, User-Agent, Host)
   *  are set natively and cannot be overridden. */
  fetch(url: string, init?: NetFetchInit): Promise<NetResponse>;
}

export interface NetFetchInit {
  /** v1: GET or POST only. Default 'GET'. */
  method?: 'GET' | 'POST';
  /** Safe caller headers only (e.g. Accept, Content-Type). Reserved/identity
   *  keys are dropped natively. */
  headers?: Record<string, string>;
  /** Request body (string; JSON.stringify at the call site). Subject to the
   *  ~60 KB bridge envelope cap. */
  body?: string;
  /** Clamped to ≤ 9000 ms natively (bridge caps at 10 s). */
  timeoutMs?: number;
  /** Reserved. v1 does NOT wire abort to the native op (which has its own
   *  timeout) — passing it is a no-op today. Kept for forward-compat. */
  signal?: AbortSignal;
}

export interface NetResponse {
  /** status in [200,299]. */
  ok: boolean;
  status: number;
  /** Response header subset (e.g. content-type). */
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface LifecycleApi {
  ready(): Promise<void>;
  rollbackAll(): void;
  /** @internal */
  _markReady(): void;
}

export interface ConfigsApi {
  /** Read a JSON config blob by name. Returns null on any miss
   *  (missing file, decrypt failure, parse failure, invalid name).
   *  The native side logs the reason at warn level; callers treat
   *  every miss uniformly. */
  read<T = unknown>(name: string): Promise<T | null>;

  /** Write a JSON config blob atomically. Rejects with the native
   *  error string on failure (invalid name, disk full, encrypt
   *  failure). Resolves to void on success. */
  write<T = unknown>(name: string, data: T): Promise<void>;
}


export interface SbContextApi {
  /** Тип target'а, в который инжектирован framework. Заполняется из
   *  injection prefix нативного инжектора (__SB_PLUGINS_MANIFEST__.contextKind). */
  readonly kind: ContextKind;

  /** Текущий URL страницы. Reactive: обновляется на pushState/replaceState/
   *  popstate/hashchange. Initial value = location.href at framework boot. */
  readonly url: string;

  /** Subscribe к URL changes. Initial-fire deferred via queueMicrotask
   *  с current URL — caller can unsubscribe before the initial fire if
   *  they wish (the guard inside the microtask honours that). Returns
   *  unsubscribe. */
  onUrlChange(cb: (url: string) => void): () => void;
}

export interface PageMatch {
  /** RegExp tested against full URL string. ИЛИ predicate (предпочтительно
   *  для нетривиальных условий — даёт доступ к URL object). */
  url: RegExp | ((u: URL) => boolean);
}

export interface PageContext {
  /** URL который сматчился. */
  readonly url: URL;
  /** Aborts на page leave ИЛИ framework rollback. */
  readonly signal: AbortSignal;
}

export interface PageHandle {
  /** Принудительно снять регистрацию. Если страница сейчас mounted —
   *  unmount fn вызывается синхронно. */
  unregister(): void;
}

export interface PagesApi {
  register(opts: {
    /** Diagnostic-only имя для логов и реестра — должно быть уникальным
     *  в рамках плагина. Падает sync throw на дубликат. */
    name: string;
    match: PageMatch;
    /** Вызывается при ВХОДЕ на match-страницу. Может вернуть unmount fn —
     *  будет вызвана при выходе или framework rollback. Может быть async. */
    mount(ctx: PageContext): void | (() => void) | Promise<void | (() => void)>;
  }): PageHandle;
}

export interface BusApi {
  /** Broadcast `data` to all OTHER injected targets that subscribed to `topic`,
   *  AND (on a microtask, local-echo) to this same instance's own local
   *  subscribers to `topic` — the native fanout skips the sender session, so
   *  two subscribers co-located in the same target/session (e.g. Main) would
   *  otherwise never hear each other.
   *  Sync throw on:
   *    - invalid topic (regex /^[a-z][a-z0-9.\-]{0,63}$/)
   *    - payload >16KB после JSON.stringify
   *    - data not JSON-serializable */
  publish(topic: string, data?: unknown): void;

  /** Subscribe к topic. cb fires synchronously when a broadcast arrives
   *  from another target, and asynchronously (on a microtask) for a
   *  same-instance publish via local-echo (see `publish`). Errors thrown by cb are caught and logged via
   *  `console.error` (do not propagate — a faulty subscriber must not
   *  starve other subscribers on the same topic). Returns unsubscribe.
   *  scope.abort drops all subs automatically.
   *  Throws synchronously for unauthorized topics: plugin may subscribe to
   *  its own `<pluginId>.*` always; foreign topics require a matching entry
   *  in the signed manifest's `subscribeTopics` allow-list. */
  subscribe(topic: string, cb: (data: unknown) => void): () => void;
}

/**
 * Capabilities that plugins may request and that the manifest may grant.
 * Effective = (plugin's requested) ∩ (manifest's granted).
 */
export const Capability = {
  Ui:       'ui',
  Steam:    'steam',
  Configs:  'configs',
  Bus:      'bus',
  Pages:    'pages',
  Keys:     'keys',
  Net:      'net',
} as const;
export type Capability = typeof Capability[keyof typeof Capability];

/**
 * The api-version currently emitted by the framework. Plugins must declare
 * an apiVersion that the framework's SUPPORTED_API_VERSIONS set contains.
 */
export const CURRENT_API_VERSION = 1;
export const SUPPORTED_API_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Result returned by plugin's init function. */
export type InitResult = void | (() => void | Promise<void>);

/**
 * What plugin author passes to sb.plugins.register({...}).
 *
 * Cross-validated against the manifest's plugin entry: id, version,
 * apiVersion must equal; contextKinds + urlPatterns must be a subset
 * of manifest's; capabilities are intersected with manifest's
 * grantedCapabilities.
 */
export interface PluginManifest {
  /** ^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$ — see PLUGIN_ID_RE. */
  readonly id: string;
  /** Semver. */
  readonly version: string;
  /** Discrete integer. Must be in framework's SUPPORTED_API_VERSIONS. */
  readonly apiVersion: number;
  /** Human-readable name. */
  readonly displayName: string;
  /** Optional longer description. */
  readonly description?: string;
  /** Which context kinds plugin runs in. */
  readonly contextKinds: ContextKind[];
  /** Optional regex source strings for URL sub-routing. */
  readonly urlPatterns?: string[];
  /** Capabilities plugin requests. */
  readonly capabilities: Capability[];
  /** Init called once per matching contextKind + urlPattern. */
  readonly init: (ctx: PluginContext) => InitResult | Promise<InitResult>;
}

/**
 * Passed to plugin's init function. Provides capability-gated sb access
 * plus per-plugin scope, configs, log.
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly contextKind: ContextKind;
  readonly apiVersion: number;
  readonly granted: ReadonlySet<Capability>;
  readonly sb: SbApi;
  readonly scope: ScopeApi;
  readonly configs: ConfigsApi;
  readonly log: LogApi;
  readonly signal: AbortSignal;
}

/**
 * Plugin's structured logger. Pipes through bridge → C++ → spdlog with
 * [plugin:<id>] prefix. Rate-limited 100 lines/sec at C++ side; client-
 * side 200 lines/sec extra guard.
 *
 * Plugin author MUST NOT log PII (account names, steamId, email, raw
 * tokens). Use placeholders like '<redacted>'.
 */
export interface LogApi {
  trace(msg: string, meta?: object): void;
  debug(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

/**
 * Plugin registry meta-API. Always available (not capability-gated).
 */
export interface PluginsApi {
  /** Register a plugin. Sync; throws on invalid args. Single call per bundle. */
  register(opts: PluginManifest): void;
  /** Resolves after all registered plugins' init has settled. */
  ready(): Promise<void>;
}


export interface AppApi {
  /** Persistent per-install token (UUID), or undefined if unavailable. */
  getSetupId(): Promise<string | undefined>;
}

export interface SbApi {
  readonly version: string;
  readonly state: 'loading' | 'ready' | 'disabled';
  /** Per-target read-only metadata (kind, live URL). See README § sb.context. */
  readonly context: SbContextApi;
  readonly app: AppApi;
  readonly ui: UiApi;
  readonly steam: SteamApi;
  readonly lifecycle: LifecycleApi;
  /** Per-injection AbortController-backed async scope. See README §
   *  "sb.scope" — every async resource that must die on rollbackAll
   *  must opt in via these helpers. */
  readonly scope: ScopeApi;
  /** Per-name encrypted JSON config storage. See README § sb.configs. */
  readonly configs: ConfigsApi;
  /** URL-matched page-router. See README § sb.pages. */
  readonly pages: PagesApi;
  /** Cross-target pub/sub via native broadcast. See README § sb.bus. */
  readonly bus: BusApi;
  /** Plugin registry meta-API. Always available (not capability-gated). */
  readonly plugins: PluginsApi;
  /** Steam product-key activation. Gated by Capability.Keys. */
  readonly keys: KeysApi;
  /** Native-proxied fetch to signed allowedHosts. Gated by Capability.Net. */
  readonly net: NetApi;
}
