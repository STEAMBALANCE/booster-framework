// Idempotent, versioned <style> for the store-nav «КАТАЛОГ ИГР» button.
// Inline CSS string (like relay/menu-items.ts::ensureStyle) rather than the
// CSS-file `type:'text'` import used by ui-toolbar-styles.ts — keeps this
// self-contained (no build.ts / define coupling). Versioned id + prefix sweep
// so a future rules change replaces the stale tag on framework re-injection.
// Figma brand pill: #34a37b, radius 6, 32px tall, 14/16 bold uppercase,
// swirl logo after the label. `!important` on visual props beats Steam's
// (un-!important) hashed-class cascade deterministically.

const STYLE_ID = '__sb_storenav_styles_v2';
const STYLE_PREFIX = '__sb_storenav_styles_';

const CSS = `
[data-booster-storenav-btn]{
  box-sizing:border-box; display:inline-flex; align-items:center;
  align-self:center; gap:8px; height:32px; padding:0 8px; margin:0 8px 0 0;
  border:0; border-radius:6px; cursor:pointer; white-space:nowrap;
  font:700 14px/16px "Motiva Sans", sans-serif; text-transform:uppercase;
  transition:background-color .12s ease, color .12s ease;
}
[data-booster-storenav-btn][data-booster-variant="brand"]{
  background:#34a37b !important; color:#fff !important;
}
/* Hover mirrors the checkout «Пополнить» header button (addHeaderButton brand
   variant): background lightens #34a37b → #3eb487, no :active pressed flash. */
[data-booster-storenav-btn][data-booster-variant="brand"]:hover{
  background:#3eb487 !important; color:#fff !important;
}
[data-booster-storenav-btn] .booster-storenav-icon{ display:inline-flex; align-items:center; }
[data-booster-storenav-btn] .booster-storenav-icon svg{ display:block; width:14px; height:12px; }
[data-booster-storenav-btn] .booster-storenav-icon img{ display:block; height:12px; width:auto; }
`;

export function ensureStoreNavStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  for (const el of Array.from(document.head.querySelectorAll('style'))) {
    if (el.id.startsWith(STYLE_PREFIX) && el.id !== STYLE_ID) el.remove();
  }
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);
}
