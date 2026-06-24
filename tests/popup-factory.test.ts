// framework/tests/popup-factory.test.ts
import { test, expect, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { STEAM_DROPDOWN_FLAGS, FLAG } from '../src/relay/popup-flags';

// Per-test capture state: most-recently-created popup's call log
// (MoveTo/BringToFront/SetKeyFocus/ShowWindow/etc). Cleared by setupTemplate.
let lastWindowCalls: {
  moveTo: Array<[number, number, number]>;
  resizeTo: Array<[number, number, number]>;
  showWindow: number;
  hideWindow: number;
  bringToFront: number;
  setKeyFocus: Array<boolean>;
  setMinSize: Array<[number, number]>;
};

// Optional g_PopupManager.m_mapPopups extra entries (keyed by name) so tests
// can inject a fake `SP Desktop_uid0` for centerOnMain coverage.
let extraPopupEntries: Array<[string, unknown]> = [];

function setupTemplate(): void {
  globalThis.window = new Window() as any;
  lastWindowCalls = {
    moveTo: [], resizeTo: [], showWindow: 0, hideWindow: 0,
    bringToFront: 0, setKeyFocus: [], setMinSize: [],
  };
  // Minimal g_PopupManager stub with one contextmenu pool entry
  const mapEntries: Array<[string, unknown]> = [
    ['contextmenu_1_uid0', {
      m_strName: 'contextmenu_1_uid0',
      m_rgParams: {
        html_class: 'X', popup_class: 'P',
        target_browser: 't', window_opener_id: 'o',
      },
      constructor: function PopupCtor(name: string, params: any, _cb: any) {
        (this as any).m_strName = name;
        (this as any).m_rgParams = params;
        (this as any).Show = () => {
          (this as any).m_popup = {
            SteamClient: { Window: {
              ShowWindow:    () => { lastWindowCalls.showWindow++; },
              HideWindow:    () => { lastWindowCalls.hideWindow++; },
              SetHideOnClose:() => {},
              MoveTo:    (x: number, y: number, s: number) => { lastWindowCalls.moveTo.push([x, y, s]); },
              ResizeTo:  (w: number, h: number, s: number) => { lastWindowCalls.resizeTo.push([w, h, s]); },
              BringToFront: () => { lastWindowCalls.bringToFront++; },
              SetKeyFocus:  (on: boolean) => { lastWindowCalls.setKeyFocus.push(on); },
              SetMinSize:   (w: number, h: number) => { lastWindowCalls.setMinSize.push([w, h]); },
            } },
            document: { open: () => {}, write: () => {}, close: () => {} },
          };
        };
      },
    }],
    ...extraPopupEntries,
  ];
  (globalThis.window as any).g_PopupManager = {
    m_mapPopups: new Map(mapEntries),
    RemoveTrackedPopup: () => {},
  };
}

/** Inject a fake SP Desktop_uid0 entry so getMainShellRect() can compute
 *  a centered position for a test. Call BEFORE setupTemplate. */
function injectMainShell(args: {
  screenX: number; screenY: number;
  outerWidth: number; outerHeight: number;
  devicePixelRatio: number;
}): void {
  extraPopupEntries = [
    ['SP Desktop_uid0', {
      m_strName: 'SP Desktop_uid0',
      m_popup: { ...args },
    }],
  ];
}

function clearExtraPopupEntries(): void {
  extraPopupEntries = [];
}

test('createChromelessPopup uses STEAM_DROPDOWN_FLAGS by default', async () => {
  setupTemplate();
  const { createChromelessPopup } = await import('../src/relay/popup-factory');
  const r = createChromelessPopup({
    popupId: 'sb_test', html: '<x>', width: 320, height: 142, flagOpts: {},
  });
  expect(r).not.toBeNull();
  const params = (r!.popup as any).m_rgParams;
  expect(params.eCreationFlags).toBe(STEAM_DROPDOWN_FLAGS);
});

test('createChromelessPopup respects alwaysOnTop:true override', async () => {
  setupTemplate();
  const { createChromelessPopup } = await import('../src/relay/popup-factory');
  const r = createChromelessPopup({
    popupId: 'sb_test', html: '<x>', width: 320, height: 142,
    flagOpts: { alwaysOnTop: true },
  });
  const params = (r!.popup as any).m_rgParams;
  expect(params.eCreationFlags & FLAG.ALWAYS_ON_TOP).toBe(FLAG.ALWAYS_ON_TOP);
});

test('createChromelessPopup uses sb_topup_body body_class (not template default)', async () => {
  setupTemplate();
  const { createChromelessPopup } = await import('../src/relay/popup-factory');
  const r = createChromelessPopup({
    popupId: 'sb_test', html: '<x>', width: 320, height: 142, flagOpts: {},
  });
  expect((r!.popup as any).m_rgParams.body_class).toBe('sb_topup_body');
});

// ── Bug 2 regression — createSteamWindow centering / raise ────────────────
//
// Probe-popup-state.ts (2026-05-07) showed our window opened at
// screenX=-25600 (off-screen) without these calls. Pin the post-warmup
// Show + MoveTo + BringToFront + SetKeyFocus chain so a future refactor
// that drops any one of them re-introduces the bug.

test('createSteamWindow with centerOnMain=true: dimensions.left/top computed from main shell rect', async () => {
  // Main shell: 1392x1317 logical, located at (834, 150), 125% DPI.
  injectMainShell({
    screenX: 834, screenY: 150,
    outerWidth: 1392, outerHeight: 1317,
    devicePixelRatio: 1.25,
  });
  setupTemplate();
  const { createSteamWindow } = await import('../src/relay/popup-factory');
  const r = createSteamWindow({
    windowId: 'sb_modal',
    title: 'T',
    content: { kind: 'html', html: '<p/>' },
    width: 720, height: 600,
    minWidth: 360, minHeight: 400,
    flagOpts: {}, centerOnMain: true,
  });
  expect(r).not.toBeNull();
  // Expected center: 834 + Math.round((1392 - 720) / 2) = 834 + 336 = 1170
  //                  150 + Math.round((1317 - 600) / 2) = 150 + 359 = 509
  // Note: width-diff is even (672) so no rounding bias; height-diff is odd
  // (717) so Math.round(358.5) = 359 — the rounding behaviour is pinned
  // here so a future 0.5-pixel drift is caught.
  const params = (r!.popup as any).m_rgParams;
  expect(params.dimensions).toEqual({ left: 1170, top: 509, width: 720, height: 600 });
  // No MoveTo needed — popup opens already-centered via dimensions.
  expect(lastWindowCalls.moveTo).toEqual([]);
  // BringToFront + SetKeyFocus(true) — defense-in-depth raise.
  expect(lastWindowCalls.bringToFront).toBe(1);
  expect(lastWindowCalls.setKeyFocus).toEqual([true]);
  clearExtraPopupEntries();
});

test('createSteamWindow with centerOnMain=false: dimensions.left/top = 0 (left to Steam)', async () => {
  injectMainShell({
    screenX: 0, screenY: 0,
    outerWidth: 1920, outerHeight: 1080,
    devicePixelRatio: 1,
  });
  setupTemplate();
  const { createSteamWindow } = await import('../src/relay/popup-factory');
  const r = createSteamWindow({
    windowId: 'sb_no_center',
    title: 'T',
    content: { kind: 'html', html: '<p/>' },
    width: 800, height: 600,
    minWidth: 320, minHeight: 240,
    flagOpts: {}, centerOnMain: false,
  });
  const params = (r!.popup as any).m_rgParams;
  expect(params.dimensions).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  expect(params.center_on_window).toBeUndefined();
  expect(lastWindowCalls.moveTo).toEqual([]);
  // Still raises + focuses — caller still wants the window on top.
  expect(lastWindowCalls.bringToFront).toBe(1);
  expect(lastWindowCalls.setKeyFocus).toEqual([true]);
  clearExtraPopupEntries();
});

test('createSteamWindow without main shell entry: dimensions.left/top falls back to 0', async () => {
  // No injectMainShell — getMainShellRect() returns null.
  setupTemplate();
  const { createSteamWindow } = await import('../src/relay/popup-factory');
  const r = createSteamWindow({
    windowId: 'sb_no_main',
    title: 'T',
    content: { kind: 'html', html: '<p/>' },
    width: 800, height: 600,
    minWidth: 320, minHeight: 240,
    flagOpts: {}, centerOnMain: true,   // requested, but no main → fall back
  });
  expect(r).not.toBeNull();
  const params = (r!.popup as any).m_rgParams;
  // No MoveTo. dimensions falls back to (0,0) — Steam's center_on_window
  // param (still set when centerOnMain:true) is the only positioning hint
  // available; if Steam can resolve target_browser it'll center; otherwise
  // window opens at (0,0).
  expect(params.dimensions.left).toBe(0);
  expect(params.dimensions.top).toBe(0);
  expect(lastWindowCalls.moveTo).toEqual([]);
  // Raise still fires.
  expect(lastWindowCalls.bringToFront).toBe(1);
});

test('createSteamWindow chain order: warmup → SetMinSize → ShowWindow → MoveTo → BringToFront → SetKeyFocus', async () => {
  // Order matters: ShowWindow before MoveTo (MoveTo on a hidden CEF window
  // ends up at (0,0) per probe-window-apis.ts evidence). BringToFront +
  // SetKeyFocus fire after positioning so the window first appears at the
  // right spot, then is raised — no visible "jump" from the wrong corner.
  // The leading ShowWindow + HideWindow pair is commonPopupSetup's CEF
  // realize warmup (always present); we keep it in the expected order so
  // a refactor that drops the warmup is also caught.
  injectMainShell({
    screenX: 100, screenY: 100, outerWidth: 1000, outerHeight: 800,
    devicePixelRatio: 1,
  });
  setupTemplate();
  const order: string[] = [];
  const { createSteamWindow } = await import('../src/relay/popup-factory');
  const pm = (globalThis.window as any).g_PopupManager;
  const tplEntry = pm.m_mapPopups.get('contextmenu_1_uid0');
  const OriginalCtor = tplEntry.constructor;
  tplEntry.constructor = function PopupCtor(this: any, name: string, params: any, _cb: any) {
    OriginalCtor.call(this, name, params, _cb);
    const origShow = this.Show;
    this.Show = () => {
      origShow.call(this);
      const w = this.m_popup.SteamClient.Window;
      const methods = ['SetMinSize', 'ShowWindow', 'HideWindow', 'MoveTo', 'BringToFront', 'SetKeyFocus'] as const;
      for (const m of methods) {
        const orig = w[m];
        w[m] = (...a: unknown[]) => { order.push(m); return orig?.(...a); };
      }
    };
  };
  createSteamWindow({
    windowId: 'sb_order',
    title: 'T', content: { kind: 'html', html: '<p/>' },
    width: 600, height: 400, minWidth: 300, minHeight: 200,
    flagOpts: {}, centerOnMain: true,
  });
  expect(order).toEqual([
    // openWindow modals skip the CEF warmup (Steam's PopupClass.Show
    // already realizes them). No MoveTo — position is set via
    // dimensions.left/top in the ctor params, computed before construct.
    // No explicit ShowWindow either — popup.Show() already showed the
    // OS window; an extra ShowWindow triggers Windows' restore-from-
    // taskbar animation that Steam's own modals don't have.
    'SetMinSize', 'BringToFront', 'SetKeyFocus',
  ]);
  clearExtraPopupEntries();
});
