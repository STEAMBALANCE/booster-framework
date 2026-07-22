// Idempotent, versioned <style> for the supernav «ОЦЕНИ АККАУНТ» button.
// Inline CSS string (like ui-storenav-styles.ts) rather than a build.ts
// `type:'text'` import — keeps this self-contained. Versioned id + prefix
// sweep so a future rules change replaces the stale tag on framework
// re-injection. Green brand pill #34a37b + spinner + red error-flash.
// `!important` on visual props beats Steam's (un-!important) hashed-class
// cascade deterministically.

const STYLE_ID = '__sb_supernav_styles_v4';
const STYLE_ID_PREFIX = '__sb_supernav_styles_';

const CSS = `
[data-booster-supernav-btn]{
  box-sizing:border-box; display:inline-flex; align-items:center; align-self:center;
  gap:8px; height:24px; padding:4px 6px; margin:0 0 0 4px;
  border:0; border-radius:2px; cursor:pointer; user-select:none; white-space:nowrap;
  -webkit-app-region:no-drag;
  /* Nudge 3px UP to optically center with Steam's supernav tab labels: the
     native 18px tab text sits high in the row (its box-center is ~47 vs the
     row center 50 — the glyphs are top-set, with space reserved below for the
     active-tab underline), so a row-centered pill reads ~3px LOW next to it.
     Value tuned against the real client at devicePixelRatio 1.25. */
  position:relative; top:-3px;
  font:700 12px/16px "Motiva Sans", Arial, Helvetica, sans-serif;
  text-transform:uppercase; letter-spacing:0;
  transition:background-color .12s ease, color .12s ease, opacity .12s ease;
}
[data-booster-supernav-btn][data-booster-variant="brand"]{ background:#34a37b !important; color:#fff !important; }
[data-booster-supernav-btn][data-booster-variant="brand"]:hover{ background:#3eb487 !important; color:#fff !important; }
[data-booster-supernav-btn][aria-disabled="true"]{ cursor:default; pointer-events:none; }
[data-booster-supernav-btn][data-booster-loading="true"]{ opacity:.65; }
.booster-supernav-spinner{ display:none; width:12px; height:12px; flex:0 0 auto;
  border-radius:50%; border:2px solid rgba(255,255,255,.35); border-top-color:#fff;
  animation:booster-supernav-spin .7s linear infinite; }
[data-booster-supernav-btn][data-booster-loading="true"] .booster-supernav-spinner{ display:inline-block; }
@keyframes booster-supernav-spin{ to{ transform:rotate(360deg); } }
[data-booster-supernav-btn][data-booster-error="true"],
[data-booster-supernav-btn][data-booster-error="true"]:hover{ background:#b3413b !important; color:#fff !important; }
`;

export function ensureSuperNavStyles(): void {
  // Stale-sweep older versions (id-prefix), then inject once. Mirrors
  // ensureStoreNavStyles / ensureToolbarStyles.
  const existing = document.querySelectorAll(`style[id^="${STYLE_ID_PREFIX}"]`);
  let current: Element | null = null;
  existing.forEach((el) => { if (el.id === STYLE_ID) current = el; else el.remove(); });
  if (current) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
