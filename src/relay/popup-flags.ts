/** eCreationFlags bits — derived from probe-popup-behavior.ts and live
 *  inspection of g_PopupManager.m_mapPopups across all popup types
 *  (Steam Notifications, Account Menu, Supernavs all use 4538634).
 *
 *  Bit values are powers of 2; a few intermediate bits (4, 16, 32-128,
 *  512-4096, 32768, 131072, 524288, 2097152) observed but unidentified —
 *  excluded from API. */
export const FLAG = {
  RESIZABLE:           1 << 0,    // bit 1 — used in SP Desktop, openWindow{resizable}
  HIDDEN:              1 << 1,    // bit 2 — created hidden (always set)
  NO_TASKBAR_ICON:     1 << 3,    // bit 8
  COMPOSITED:          1 << 8,    // bit 256 — GPU-accelerated rendering
  ALWAYS_ON_TOP:       1 << 13,   // bit 8192
  NO_WINDOW_SHADOW:    1 << 14,   // bit 16384
  NATIVE_BORDER:       1 << 16,   // bit 65536 — observed in Steam dropdowns
  NO_ROUNDED_CORNERS:  1 << 18,   // bit 262144
  OVERRIDE_REDIRECT:   1 << 20,   // bit 1048576 — X11-only, no-op on Win
  TRANSPARENT_PARENT:  1 << 22,   // bit 4194304
} as const;

/** Steam-native dropdown flag set (Notifications/Account/Supernavs).
 *  Decimal: 4538634. Sum: 2 + 8 + 256 + 16384 + 65536 + 262144 + 4194304. */
export const STEAM_DROPDOWN_FLAGS =
  FLAG.HIDDEN | FLAG.NO_TASKBAR_ICON | FLAG.COMPOSITED |
  FLAG.NO_WINDOW_SHADOW | FLAG.NATIVE_BORDER | FLAG.NO_ROUNDED_CORNERS |
  FLAG.TRANSPARENT_PARENT;

export interface AttachPopupFlagOpts {
  alwaysOnTop?: boolean;
  nativeBorder?: boolean;
  noTaskbarIcon?: boolean;
  noWindowShadow?: boolean;
  noRoundedCorners?: boolean;
  composited?: boolean;
  transparentParent?: boolean;
  overrideRedirect?: boolean;
}

/** Build eCreationFlags int from named-booleans.
 *  Defaults match STEAM_DROPDOWN_FLAGS (4538634) so голый attachPopup
 *  без флагов даёт правильный native look. HIDDEN всегда set
 *  (created-hidden invariant — popup not visible until first show). */
export function buildAttachPopupFlags(opts: AttachPopupFlagOpts): number {
  const def = (v: boolean | undefined, fallback: boolean): boolean =>
    v === undefined ? fallback : v;

  let f = FLAG.HIDDEN;  // always set
  if (def(opts.noTaskbarIcon,    true))  f |= FLAG.NO_TASKBAR_ICON;
  if (def(opts.composited,       true))  f |= FLAG.COMPOSITED;
  if (def(opts.alwaysOnTop,      false)) f |= FLAG.ALWAYS_ON_TOP;
  if (def(opts.noWindowShadow,   true))  f |= FLAG.NO_WINDOW_SHADOW;
  if (def(opts.nativeBorder,     true))  f |= FLAG.NATIVE_BORDER;
  if (def(opts.noRoundedCorners, true))  f |= FLAG.NO_ROUNDED_CORNERS;
  if (def(opts.overrideRedirect, false)) f |= FLAG.OVERRIDE_REDIRECT;
  if (def(opts.transparentParent,true))  f |= FLAG.TRANSPARENT_PARENT;
  return f;
}

export interface OpenWindowFlagOpts {
  resizable?: boolean;
  noTaskbarIcon?: boolean;
  alwaysOnTop?: boolean;
  composited?: boolean;
  // NATIVE_BORDER / NO_WINDOW_SHADOW / NO_ROUNDED_CORNERS /
  // TRANSPARENT_PARENT / OVERRIDE_REDIRECT не expose-им — модалкам они
  // не нужны: title bar custom, OS-нативный border лишний.
}

/** Steam-modal-style flag set. Decimal: 2 (HIDDEN only).
 *
 *  Empirically tuned via `scripts/probe-move-methods.ts` (2026-05-07):
 *
 *    - `eCreationFlags=2` (HIDDEN only): `MoveTo`/`MoveToLocation` work,
 *      `center_on_window` honoured, NO Windows DWM restore-from-taskbar
 *      animation. Matches Steam's "Новости обновлений" modal exactly.
 *      User-resize comes from the OS-native border + drag-grip that DWM
 *      adds for HIDDEN-only top-level windows.
 *    - `eCreationFlags=3` (RESIZABLE | HIDDEN): center_on_window still
 *      works, but adding the RESIZABLE bit makes Windows treat the
 *      first show as "restore-from-taskbar" with the slide-up animation
 *      (Steam's modals do NOT have this animation).
 *    - `eCreationFlags=259` (RESIZABLE | HIDDEN | COMPOSITED): user-resize
 *      works, but `MoveTo` returns "Unknown method" and `center_on_window`
 *      is silently ignored — Steam routes to the chromeless dropdown
 *      code-path.
 *
 *  flags=2 is the only option that ships ALL of: centering + no animation
 *  + user-resize (via OS frame). */
export const STEAM_MODAL_FLAGS = FLAG.HIDDEN;

export function buildOpenWindowFlags(opts: OpenWindowFlagOpts): number {
  // HIDDEN always set (created-hidden invariant). RESIZABLE / COMPOSITED
  // both DEFAULT OFF — see STEAM_MODAL_FLAGS jsdoc for the empirical
  // rationale. Setting either flips Steam to a different code-path
  // (RESIZABLE → DWM restore-from-taskbar animation; COMPOSITED →
  // chromeless dropdown route losing `center_on_window` + `MoveTo`).
  // Caller can opt in explicitly if they need them. NO_TASKBAR_ICON /
  // ALWAYS_ON_TOP remain opt-in for transient overlays.
  let f = FLAG.HIDDEN;
  if (opts.resizable    === true) f |= FLAG.RESIZABLE;
  if (opts.composited   === true) f |= FLAG.COMPOSITED;
  if (opts.alwaysOnTop  === true) f |= FLAG.ALWAYS_ON_TOP;
  if (opts.noTaskbarIcon === true) f |= FLAG.NO_TASKBAR_ICON;
  return f;
}
