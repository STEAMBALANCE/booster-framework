// Pure-function helper composing wrapper HTML for an openWindow.
// No DOM / BroadcastChannel deps — composed string is later
// document.write'n into popup window by createSteamWindow.

import { RELAY_CHANNEL, WINDOW_MESSAGE_MAX_BYTES } from './protocol';
import { LL } from '../i18n';
import { RELAY_AUTH_FIELD, type RelayAuthToken } from './auth';
// Static wrapper chrome. Single source of truth is the .css; dev/tests read it
// raw via the `type: 'text'` import, production injects a minified copy through
// the `__SB_WRAPPER_CSS__` bun define (see build.ts → loadCss), which folds the
// ternary and tree-shakes the raw import out of the shipped bundle.
import WRAPPER_CSS_RAW from './window-wrapper-styles.css' with { type: 'text' };

declare const __SB_WRAPPER_CSS__: string | undefined;

const WRAPPER_CSS =
  typeof __SB_WRAPPER_CSS__ !== 'undefined' ? __SB_WRAPPER_CSS__ : WRAPPER_CSS_RAW;

declare const __SB_FRAMEWORK_VERSION__: string | undefined;
const APP_VERSION =
  typeof __SB_FRAMEWORK_VERSION__ !== 'undefined' ? __SB_FRAMEWORK_VERSION__ : '0.0.0-dev';

export interface WrapperArgs {
  /** Used ONLY by the wrapper script's BC routing key (interpolated via
   *  JSON.stringify into POPUP_ID literal); never appears in any HTML
   *  attribute or text node. */
  windowId: string;
  title: string;
  content: { kind: 'url'; url: string } | { kind: 'html'; html: string };
  /** Background colour shown around the iframe (visible when the
   *  embedded content's natural width is narrower than the popup, e.g.
   *  Jivo at 360px logical inside a wider window). Default '#fff' suits
   *  most chat embeds and other light-themed pages; pass a darker tone
   *  (e.g. '#1b1d23') for dark-themed embeds so margins don't look out
   *  of place. CSS-color string — passed through unchanged into the
   *  inline `<style>` block, so caller is trusted (matches the trust
   *  boundary on `html` content). */
  iframeBackground?: string;
  /** Allowlist дополнительных origin'ов (помимо origin стартового url),
   *  которым обёртка отвечает на sb:ready. Default = [FRAME_ORIGIN]. */
  embedOrigins?: string[];
  relayAuthToken?: RelayAuthToken;
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure inbound-message guard, inlined into the wrapper <script> via
 *  `.toString()`. CRITICAL: use only the four args, no module-scope refs. */
export function acceptFrameMessage(
  source: unknown,
  origin: string,
  frameWindow: unknown,
  embedOrigins: string[],
): boolean {
  return source != null && source === frameWindow && embedOrigins.indexOf(origin) !== -1;
}

/** Pure-function BC listener body for the wrapper script.
 *
 *  Exported so unit tests can verify behavior without JSDOM-eval'ing
 *  the composed HTML. composeWrapperHtml inlines this function via
 *  `.toString()` into the popup's <script>.
 *
 *  CRITICAL: only use the four arguments. Do NOT close over module-
 *  scoped variables — the function is serialized to source and
 *  evaluated in the popup window's V8 context, where outer references
 *  don't exist.
 */
export function handleWrapperBcMessage(
  data: unknown,
  doc: Document,
  popupId: string,
  frameOrigin: string,
): void {
  if (!data || typeof data !== 'object') return;
  const m = data as Record<string, unknown>;
  if (m.windowId !== popupId) return;
  if (m.kind === 'window-set-title') {
    const t = String(m.title == null ? '' : m.title);
    const titleEl = doc.getElementById('booster-win-title');
    if (titleEl) titleEl.textContent = t;
    doc.title = t;
    return;
  }
  if (m.kind === 'window-postMessage' && frameOrigin) {
    const frame = doc.getElementById('booster-win-frame') as unknown as
      { contentWindow?: { postMessage?: (d: unknown, o: string) => void } } | null;
    const w = frame && frame.contentWindow;
    if (w && typeof w.postMessage === 'function') {
      try { w.postMessage(m.data, frameOrigin); } catch (e) { /* */ }
    }
  }
}

export function composeWrapperHtml(args: WrapperArgs): string {
  const escapedTitle  = escapeHtmlText(args.title);
  const idLiteral     = JSON.stringify(args.windowId);
  const channelLiteral = JSON.stringify(RELAY_CHANNEL);
  // Default '#fff' covers chat embeds + most light-themed pages.
  // No escaping here because we trust the caller (mirrors the html-mode
  // trust boundary documented in WrapperArgs.iframeBackground).
  const iframeBg = args.iframeBackground ?? '#fff';

  // Per-window background — the embed's predominant tone — so margins don't
  // letterbox when the content is narrower than the popup. Composed inline
  // (kept out of the static WRAPPER_CSS) because the colour is dynamic; lives
  // in the bundle as a tiny template fragment, not an unminifiable comment.
  const iframeRule = `iframe.frame{display:block;width:100%;height:calc(100% - 32px);border:0;background:${iframeBg}}`;

  const iframeAttr = args.content.kind === 'url'
    ? `src="${escapeHtmlAttr(args.content.url)}"`
    : `srcdoc="${escapeHtmlAttr(args.content.html)}"`;

  let frameOrigin = '';
  if (args.content.kind === 'url') {
    try { frameOrigin = new URL(args.content.url).origin; } catch { frameOrigin = ''; }
  }
  const embedOrigins = frameOrigin
    ? Array.from(new Set([frameOrigin, ...(args.embedOrigins ?? [])]))
    : [];
  const frameOriginLiteral  = JSON.stringify(frameOrigin);
  const embedOriginsLiteral = JSON.stringify(embedOrigins);
  const appVersionLiteral   = JSON.stringify(APP_VERSION);
  const relayAuthFieldLiteral = JSON.stringify(RELAY_AUTH_FIELD);
  const relayAuthTokenLiteral = JSON.stringify(args.relayAuthToken);
  const MSG_CAP = WINDOW_MESSAGE_MAX_BYTES;
  const acceptLiteral = acceptFrameMessage.toString();

  // html/body classes match Steam's "Новости обновлений" modal exactly.
  // Steam's PopupClass also accepts these via ctor params (html_class /
  // body_class), but document.write below would wipe them — so we
  // hardcode in our wrapper. The classes activate Steam's React modal
  // CSS rules (loaded into every popup) and may suppress the Windows
  // DWM restore-from-taskbar animation that bare flags=2 doesn't.
  return `<!DOCTYPE html>
<html lang="ru" class="client_chat_frame fullheight ModalDialogPopup">
<head><meta charset="utf-8"><title>${escapedTitle}</title>
<style>${WRAPPER_CSS}${iframeRule}</style></head>
<body class="fullheight ModalDialogBody DesktopUI">
  <div class="title-bar">
    <div class="title" id="booster-win-title">${escapedTitle}</div>
    <button class="close-btn" id="booster-win-close" aria-label="${LL.framework.window.close_aria_label()}">&#x2715;</button>
  </div>
  <iframe id="booster-win-frame" class="frame" ${iframeAttr}
          allow="clipboard-read; clipboard-write"></iframe>
  <script>
  (() => {
    const POPUP_ID = ${idLiteral};
    const FRAME_ORIGIN = ${frameOriginLiteral};
    const EMBED_ORIGINS = ${embedOriginsLiteral};
    const APP_VERSION = ${appVersionLiteral};
    const RELAY_AUTH_FIELD = ${relayAuthFieldLiteral};
    const RELAY_AUTH_TOKEN = ${relayAuthTokenLiteral};
    const MSG_CAP = ${MSG_CAP};
    const sbBC = new BroadcastChannel(${channelLiteral});
    const frame = document.getElementById('booster-win-frame');
    function relayMsg(m) {
      if (RELAY_AUTH_TOKEN) m[RELAY_AUTH_FIELD] = RELAY_AUTH_TOKEN;
      return m;
    }
    document.getElementById('booster-win-close').addEventListener('click', () => {
      try { sbBC.postMessage(relayMsg({ kind:'window-user-close', windowId: POPUP_ID })); } catch (e) {}
      try { window.SteamClient.Window.Close(); } catch (e) {}
    });
    function buildEmbed() {
      // v:1 — версия протокола; должна совпадать с SB_EMBED_V в protocol.ts.
      // Импорт здесь невозможен: функция сериализуется через .toString() и
      // выполняется в контексте попапа, где module-scope недоступен.
      return { __sbEmbed:true, v:1, type:'sb:embed', windowId: POPUP_ID,
               app:{ name:'SteamBooster', version: APP_VERSION } };
    }
    function sendEmbed() {
      if (!FRAME_ORIGIN) return;
      const w = frame && frame.contentWindow;
      if (w) { try { w.postMessage(buildEmbed(), FRAME_ORIGIN); } catch (e) {} }
    }
    if (frame) frame.addEventListener('load', sendEmbed);
    const accept = ${acceptLiteral};
    function onFrameMsg(e) {
      const w = frame && frame.contentWindow;
      if (!accept(e.source, e.origin, w, EMBED_ORIGINS)) return;
      const d = e.data;
      if (d && d.__sbEmbed === true && d.type === 'sb:ready') {
        try { e.source.postMessage(buildEmbed(), e.origin); } catch (er) {}
        return;
      }
      // inbound cap: JSON.stringify length (UTF-16 ед.) — намеренная
      // асимметрия с outbound (UTF-8 байты в ui.ts); оба ~16 КБ, точная
      // мера не критична, это backstop против флуда.
      try { if (JSON.stringify(d).length > MSG_CAP) return; } catch (er) { return; }
      try { sbBC.postMessage(relayMsg({ kind:'window-message', windowId: POPUP_ID, data: d })); } catch (er) {}
    }
    window.addEventListener('message', onFrameMsg);
    const handleBc = ${handleWrapperBcMessage.toString()};
    sbBC.addEventListener('message', (e) => { handleBc(e.data, document, POPUP_ID, FRAME_ORIGIN); });
    const cleanupBC = () => {
      try { window.removeEventListener('message', onFrameMsg); } catch (e) {}
      try { sbBC.close(); } catch (e) {}
    };
    window.addEventListener('unload',   cleanupBC);
    window.addEventListener('pagehide', cleanupBC);
  })();
  </script>
</body></html>`;
}
