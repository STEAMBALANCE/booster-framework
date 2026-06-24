// Toolbar styles for booster-* buttons live in the sibling ui-toolbar-styles.css
// (full design rationale + Steam-native cascade notes are documented there).
// The stylesheet is the single source of truth: tests + dev builds read it
// raw via the `type: 'text'` import; production builds inject a minified copy
// through the `__SB_TOOLBAR_CSS__` bun define (see build.ts → loadCss), which
// const-folds the ternary and tree-shakes the raw import out of the shipped
// bundle. Strips comments + whitespace from the production payload.
//
// Style id carries a version suffix so a future ship of new toolbar CSS
// replaces stale `__sb_toolbar_styles_v*` rather than colliding with it on
// framework re-injection.
import SB_TOOLBAR_CSS_RAW from './ui-toolbar-styles.css' with { type: 'text' };

declare const __SB_TOOLBAR_CSS__: string | undefined;

const SB_TOOLBAR_STYLE_ID = '__sb_toolbar_styles_v9';
const SB_TOOLBAR_STYLE_PREFIX = '__sb_toolbar_styles_';
const SB_TOOLBAR_CSS =
  typeof __SB_TOOLBAR_CSS__ !== 'undefined' ? __SB_TOOLBAR_CSS__ : SB_TOOLBAR_CSS_RAW;

// Idempotent style injection. Removes any earlier-version toolbar style
// element first so a freshly-injected framework can ship updated rules
// even if a stale style tag from a previous version is in the DOM.
export function ensureToolbarStyles(): void {
  if (document.getElementById(SB_TOOLBAR_STYLE_ID)) return;
  // Sweep stale `__sb_toolbar_styles_v*` tags so the freshly-evaluated
  // CSS wins. Targeting by id-prefix keeps unrelated <style> tags safe.
  for (const el of Array.from(document.head.querySelectorAll('style'))) {
    if (el.id.startsWith(SB_TOOLBAR_STYLE_PREFIX) && el.id !== SB_TOOLBAR_STYLE_ID) {
      el.remove();
    }
  }
  const styleEl = document.createElement('style');
  styleEl.id = SB_TOOLBAR_STYLE_ID;
  styleEl.textContent = SB_TOOLBAR_CSS;
  document.head.appendChild(styleEl);
}
