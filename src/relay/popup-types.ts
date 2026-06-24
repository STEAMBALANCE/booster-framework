// Shared structural types for Steam's PopupClass instances. All three
// relay modules (shared-context, popup-factory, popup-lifecycle) import
// from here so a Steam shape change shows up in one place.

export interface SteamPopupWindow {
  SteamClient?: {
    Window?: {
      MoveTo?: (x: number, y: number, scale: number) => void;
      ResizeTo?: (w: number, h: number, scale: number) => void;
      ShowWindow?: () => void;
      HideWindow?: () => void;
      BringToFront?: () => void;
      SetKeyFocus?: (on: boolean) => void;
      SetHideOnClose?: (on: boolean) => void;
      SetMinSize?: (w: number, h: number) => void;
      Close?: () => void;
    };
  };
  document: {
    open(): void;
    write(html: string): void;
    close(): void;
    hasFocus?(): boolean;
  };
  close?: () => void;
  closed?: boolean;
}

export interface SteamPopupInstance {
  m_strName?: string;
  m_rgParams?: SteamPopupParams;
  m_popup?: SteamPopupWindow | null;
  Show: () => void;
  Close?: () => void;
  BIsClosed?: () => boolean;
}

export interface SteamPopupParams {
  html_class: string;
  body_class: string;
  popup_class: string;
  replace_existing_popup: boolean;
  target_browser: unknown;
  window_opener_id: unknown;
  bHideOnClose: boolean;
  eCreationFlags: number;
  dimensions: { left: number; top: number; width: number; height: number };
  /** Empirically observed on "Специальные предложения" modal (probe-modal.ts
   *  log 2026-05-07). Steam PopupClass ctor accepts these — used by
   *  openWindow / future modal-style popups. */
  minWidth?: number;
  minHeight?: number;
  /** First-show centering on the named browser (typically main shell's
   *  target_browser id). */
  center_on_window?: unknown;
}

export interface SteamPopupConstructor {
  new (name: string, params: SteamPopupParams, fnReadyToRender: (el: unknown) => void): SteamPopupInstance;
}
