// SharedJSContext-side manager for custom items injected into Steam's top-nav
// "supernav" dropdowns (store / library / community / profile). These are Steam
// context-menu popups tracked in g_PopupManager.m_mapPopups — reachable ONLY
// from the SharedJSContext (the Main window has no g_PopupManager), which is
// why this lives in the relay rather than in a plugin.
//
// Responsibilities:
//   - keep each managed item present at the top/bottom of its target popup's
//     menu list, across menu open/close and React re-renders (persistent
//     reconcile interval + per-popup MutationObserver);
//   - render it 1:1 with native items (clone the sibling className) plus a
//     variant-specific colour treatment;
//   - navigate the MAIN Steam window on click (MainWindowBrowserManager.LoadURL);
//   - SANITISE the caller-provided icon SVG (this DOM is Steam's privileged
//     context; Capability.Ui is also granted to third-party approved plugins).

import { nativeWarn } from '../native-warn';
import type { ScopeApi } from '../api/scope';
import { isUrlSafeForNavigation } from '../api/steam';
import {
  MENU_ITEM_ID_RE, MENU_ITEM_LABEL_MAX, MENU_ITEM_ICON_MAX_BYTES,
  MENU_POPUP_TITLE,
  type SteamMenuName,
  type AddMenuItemRequest,
  type RemoveMenuItemRequest,
} from './protocol';

// Colours from live CDP recon of a native store-supernav item:
//   idle brand → bg #34A37B33 (20% alpha), text+icon #93E0AD
//   Steam's own hover → bg #DCDEDF, text #3D4450 (we reuse it for hover)
const BRAND_IDLE_BG = '#34A37B33';
const BRAND_IDLE_FG = '#93E0AD';
const STEAM_HOVER_BG = '#DCDEDF';
const STEAM_HOVER_FG = '#3D4450';

// Reconcile cadence. Cheap (a Map scan + a querySelector); this is the
// durability guarantee that survives popup destroy/recreate and any React
// re-render the per-popup observer misses.
const RECONCILE_MS = 800;

const SVG_NS = 'http://www.w3.org/2000/svg';

// Conservative SVG allowlist — enough for flat icon marks, nothing scriptable.
// Ref-based tags (defs/gradients/clipPath/mask/symbol/use) are deliberately
// excluded: their only use is url(#id) references, which the value filter
// strips anyway, so they'd be dead weight that only widens the attack surface.
const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'title', 'desc',
]);
const SVG_ALLOWED_ATTRS = new Set([
  'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'fill-rule', 'clip-rule',
  'viewbox', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'opacity', 'fill-opacity',
  'stroke-opacity', 'aria-hidden', 'xmlns', 'preserveaspectratio',
]);

interface SteamPopupInstance { m_popup?: { document?: Document } | null }
interface PopupManager { m_mapPopups?: Map<string, SteamPopupInstance> }

interface ManagedItem {
  id: string;                 // prefixed menuItemId (also the DOM data-attr value)
  popupTitle: string;         // target popup document.title
  label: string;
  iconSvg?: string;
  url: string;
  variant: 'brand' | 'default';
  placement: 'top' | 'bottom';
  observer: MutationObserver | null;
  observedList: Element | null;
}

export interface MenuItemsManager {
  handleAdd(msg: AddMenuItemRequest): void;
  handleRemove(msg: RemoveMenuItemRequest): void;
  teardown(): void;
}

// Cross-plugin isolation note: `createPluginUi` prefixes every menuItemId with
// the authoritative plugin id (`<pluginId>__<id>`), so the `items` Map keyed by
// the full id is already collision-free across plugins — a plugin cannot
// address another's item through the sanctioned API. We deliberately do NOT add
// an owner-vs-id check: since the id embeds its own owner prefix, such a check
// is a tautology (it can never distinguish a forged id from a legitimate one)
// and would be dead code.

export function createMenuItemsManager(deps: {
  post: (m: object) => void;
  scope: ScopeApi;
}): MenuItemsManager {
  const { post, scope } = deps;
  const items = new Map<string, ManagedItem>();
  let intervalHandle: number | null = null;

  function gpm(): PopupManager | undefined {
    return (window as unknown as { g_PopupManager?: PopupManager }).g_PopupManager;
  }

  function findPopupDoc(title: string): Document | null {
    const map = gpm()?.m_mapPopups;
    if (!map) return null;
    for (const [, v] of map) {
      try {
        const doc = v?.m_popup?.document;
        if (doc && doc.title === title) return doc;
      } catch { /* cross-realm transient — skip */ }
    }
    return null;
  }

  function findList(doc: Document): Element | null {
    // The menu list is the parent of any native `.contextMenuItem` row. This
    // stable class survives Steam's hashed CSS-module renames.
    const anyItem = doc.querySelector('.contextMenuItem');
    return anyItem ? anyItem.parentElement : null;
  }

  // ── icon sanitisation ──
  function sanitizeSvg(svg: string, doc: Document): Element | null {
    let parsed: Document;
    try { parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'); }
    catch { return null; }
    const root = parsed.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') return null;
    if (parsed.getElementsByTagName('parsererror').length > 0) return null;

    const clean = (src: Element): Element | null => {
      const tag = src.tagName.toLowerCase();
      if (!SVG_ALLOWED_TAGS.has(tag)) return null;
      const el = doc.createElementNS(SVG_NS, tag);
      for (const attr of Array.from(src.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) continue;
        if (!SVG_ALLOWED_ATTRS.has(name)) continue;
        if (/url\(|javascript:|expression\(/i.test(attr.value)) continue;
        el.setAttribute(attr.name, attr.value);
      }
      for (const child of Array.from(src.children)) {
        const c = clean(child);
        if (c) el.appendChild(c);
      }
      return el;
    };
    return clean(root);
  }

  function appendIcon(span: HTMLElement, icon: string, doc: Document): void {
    if (/^data:image\//i.test(icon)) {
      const img = doc.createElement('img');
      img.src = icon;
      img.alt = '';
      img.style.height = '12px';
      img.style.width = 'auto';
      img.style.display = 'block';
      span.appendChild(img);
      return;
    }
    const svg = sanitizeSvg(icon, doc);
    if (svg) span.appendChild(svg);
    // else: icon rejected by the sanitiser — item still renders label-only.
  }

  // ── DOM build / style ──
  function ensureStyle(item: ManagedItem, doc: Document): void {
    const styleId = `sb-mi-style-${item.id}`;
    if (doc.getElementById(styleId)) return;
    const st = doc.createElement('style');
    st.id = styleId;
    // Attribute selector (quoted) — id charset is regex-constrained so the
    // value is safe, and this dodges CSS id-escaping edge cases.
    const sel = `[data-sb-menu-item-id="${item.id}"]`;
    let css =
      `${sel}{justify-content:space-between;gap:12px;}` +
      `${sel} .sb-menu-item-icon{display:inline-flex;align-items:center;}` +
      `${sel} .sb-menu-item-icon svg{display:block;height:12px;width:auto;}`;
    if (item.variant === 'brand') {
      // idle → brand; hover → native Steam item look. !important beats Steam's
      // (un-!important) rules deterministically regardless of hashed classes.
      css +=
        `${sel}:not(:hover){background:${BRAND_IDLE_BG}!important;color:${BRAND_IDLE_FG}!important;}` +
        `${sel}:hover{background:${STEAM_HOVER_BG}!important;color:${STEAM_HOVER_FG}!important;}`;
    }
    st.textContent = css;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function buildItemEl(item: ManagedItem, doc: Document, list: Element): HTMLElement {
    const el = doc.createElement('div');
    el.id = item.id;
    el.setAttribute('role', 'menuitem');
    el.setAttribute('data-sb-menu-item-id', item.id);
    // Clone a sibling's className for pixel-1:1 padding/font/height/hover.
    const sibling = list.querySelector('.contextMenuItem');
    if (sibling) el.className = sibling.className;
    el.classList.add('sb-menu-item');

    const label = doc.createElement('span');
    label.className = 'sb-menu-item-label';
    label.textContent = item.label;
    el.appendChild(label);

    if (item.iconSvg) {
      const iconSpan = doc.createElement('span');
      iconSpan.className = 'sb-menu-item-icon';
      appendIcon(iconSpan, item.iconSvg, doc);
      el.appendChild(iconSpan);
    }

    el.onclick = (): void => {
      if (!isUrlSafeForNavigation(item.url)) return;
      try {
        const mwbm = (window as unknown as {
          MainWindowBrowserManager?: { ShowURL?: (u: string) => void; LoadURL?: (u: string) => void };
        }).MainWindowBrowserManager;
        // ShowURL switches the main window's router to the /browser/ route AND
        // loads the URL — this is what Steam's own store-nav items call, so it
        // works from any view (e.g. clicking from inside the Library). LoadURL
        // only rewrites the (possibly hidden) browser's content without
        // switching the active view, so it does nothing when the main window is
        // showing the Library. Fall back to LoadURL on older clients.
        if (mwbm?.ShowURL) mwbm.ShowURL(item.url);
        else mwbm?.LoadURL?.(item.url);
        // Native blur-dismiss closes the supernav: navigation moves focus to the
        // main window, tripping Steam's own outside-click dismiss. We do NOT
        // call popup.Close() — that can leave a dangling g_PopupManager entry.
      } catch (e) {
        nativeWarn('menu-item navigate failed', { id: item.id, error: String(e) });
      }
    };
    return el;
  }

  function insert(item: ManagedItem, doc: Document, list: Element): void {
    ensureStyle(item, doc);
    const el = buildItemEl(item, doc, list);
    if (item.placement === 'bottom') list.appendChild(el);
    else list.insertBefore(el, list.firstChild);
  }

  function ensureObserver(item: ManagedItem, list: Element, doc: Document): void {
    if (item.observer && item.observedList === list) return;
    if (item.observer) { try { item.observer.disconnect(); } catch { /* */ } }
    const obs = scope.observer(new MutationObserver(() => {
      // Re-inject if a React re-render wiped our node. Absent-guard → no dup,
      // and we don't trigger React state changes, so no ping-pong loop.
      if (!list.isConnected) return;
      if (!list.querySelector(`[data-sb-menu-item-id="${item.id}"]`)) {
        try { insert(item, doc, list); }
        catch (e) { nativeWarn('menu-item re-inject failed', { id: item.id, error: String(e) }); }
      }
    }));
    obs.observe(list, { childList: true });
    item.observer = obs;
    item.observedList = list;
  }

  function reconcile(item: ManagedItem): void {
    const doc = findPopupDoc(item.popupTitle);
    if (!doc) {
      // Popup absent (not opened yet, or destroyed). Drop a stale observer.
      if (item.observer) { try { item.observer.disconnect(); } catch { /* */ } }
      item.observer = null;
      item.observedList = null;
      return;
    }
    const list = findList(doc);
    if (!list) return; // no native items rendered yet — retry next tick
    if (!list.querySelector(`[data-sb-menu-item-id="${item.id}"]`)) {
      insert(item, doc, list);
    } else {
      ensureStyle(item, doc); // style may have been wiped even if node survived
    }
    ensureObserver(item, list, doc);
  }

  function ensureInterval(): void {
    if (intervalHandle !== null || items.size === 0) return;
    intervalHandle = scope.setInterval(() => {
      for (const item of items.values()) {
        try { reconcile(item); }
        catch (e) { nativeWarn('menu-item reconcile threw', { id: item.id, error: String(e) }); }
      }
    }, RECONCILE_MS);
  }

  function removeInjectedNodes(item: ManagedItem): void {
    const doc = findPopupDoc(item.popupTitle);
    if (!doc) return;
    try { doc.querySelector(`[data-sb-menu-item-id="${item.id}"]`)?.remove(); } catch { /* */ }
    try { doc.getElementById(`sb-mi-style-${item.id}`)?.remove(); } catch { /* */ }
  }

  function destroyItem(item: ManagedItem): void {
    if (item.observer) { try { item.observer.disconnect(); } catch { /* */ } }
    item.observer = null;
    item.observedList = null;
    removeInjectedNodes(item);
  }

  function handleAdd(msg: AddMenuItemRequest): void {
    const reply = (ok: boolean, error?: string): void => post({
      kind: ok ? 'menu-item-added' : 'menu-item-error',
      requestId: msg.requestId,
      menuItemId: msg.menuItemId,
      ...(error ? { error } : {}),
    });
    try {
      // Defense-in-depth re-validation (the framework validated on the way in,
      // but framework + relay live in different realms — a rogue poster could
      // skip ui.ts).
      if (typeof msg.menuItemId !== 'string' || !MENU_ITEM_ID_RE.test(msg.menuItemId)) {
        return reply(false, 'invalid menuItemId');
      }
      const existing = items.get(msg.menuItemId);
      const popupTitle = MENU_POPUP_TITLE[msg.menu as SteamMenuName];
      if (!popupTitle) return reply(false, `invalid menu "${msg.menu}"`);
      if (typeof msg.label !== 'string' || msg.label.length === 0
          || msg.label.length > MENU_ITEM_LABEL_MAX) {
        return reply(false, 'invalid label');
      }
      if (typeof msg.url !== 'string' || msg.url.length > 2048
          || !isUrlSafeForNavigation(msg.url)) {
        return reply(false, 'url failed safety check');
      }
      if (msg.iconSvg !== undefined
          && (typeof msg.iconSvg !== 'string' || msg.iconSvg.length > MENU_ITEM_ICON_MAX_BYTES)) {
        return reply(false, 'icon too large');
      }
      const variant = msg.variant === 'brand' ? 'brand' : 'default';
      const placement = msg.placement === 'bottom' ? 'bottom' : 'top';

      if (existing) {
        // Idempotent re-add (re-inject / spec change): tear down the currently
        // injected node + observer under the OLD spec FIRST (the target popup
        // may be changing), THEN adopt the new spec and re-inject below.
        // Reassigning popupTitle before the teardown would orphan a node left
        // in the old popup (removeInjectedNodes looks up by popupTitle).
        destroyItem(existing);
        existing.popupTitle = popupTitle;
        existing.label = msg.label;
        existing.iconSvg = msg.iconSvg;
        existing.url = msg.url;
        existing.variant = variant;
        existing.placement = placement;
      } else {
        items.set(msg.menuItemId, {
          id: msg.menuItemId, popupTitle,
          label: msg.label, iconSvg: msg.iconSvg, url: msg.url,
          variant, placement, observer: null, observedList: null,
        });
      }
      ensureInterval();
      // Inject immediately so the item shows without waiting a reconcile tick.
      try { reconcile(items.get(msg.menuItemId)!); } catch { /* reconcile logs */ }
      reply(true);
    } catch (e) {
      reply(false, String(e));
    }
  }

  function handleRemove(msg: RemoveMenuItemRequest): void {
    const item = items.get(msg.menuItemId);
    if (!item) return; // idempotent
    destroyItem(item);
    items.delete(msg.menuItemId);
    if (items.size === 0 && intervalHandle !== null) {
      scope.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  function teardown(): void {
    for (const item of items.values()) destroyItem(item);
    items.clear();
    if (intervalHandle !== null) {
      scope.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return { handleAdd, handleRemove, teardown };
}
