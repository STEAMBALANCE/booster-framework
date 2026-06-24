import { test, expect } from 'bun:test';
import {
  FLAG,
  STEAM_DROPDOWN_FLAGS,
  buildAttachPopupFlags,
} from '../src/relay/popup-flags';

test('FLAG bit values match observed Steam constants', () => {
  expect(FLAG.RESIZABLE).toBe(1);
  expect(FLAG.HIDDEN).toBe(2);
  expect(FLAG.NO_TASKBAR_ICON).toBe(8);
  expect(FLAG.COMPOSITED).toBe(256);
  expect(FLAG.ALWAYS_ON_TOP).toBe(8192);
  expect(FLAG.NO_WINDOW_SHADOW).toBe(16384);
  expect(FLAG.NATIVE_BORDER).toBe(65536);
  expect(FLAG.NO_ROUNDED_CORNERS).toBe(262144);
  expect(FLAG.OVERRIDE_REDIRECT).toBe(1048576);
  expect(FLAG.TRANSPARENT_PARENT).toBe(4194304);
});

test('STEAM_DROPDOWN_FLAGS sums to 4538634 (Steam Notifications observed)', () => {
  expect(STEAM_DROPDOWN_FLAGS).toBe(4538634);
});

test('STEAM_DROPDOWN_FLAGS composed via FLAG.* OR', () => {
  expect(STEAM_DROPDOWN_FLAGS).toBe(
    FLAG.HIDDEN | FLAG.NO_TASKBAR_ICON | FLAG.COMPOSITED |
    FLAG.NO_WINDOW_SHADOW | FLAG.NATIVE_BORDER | FLAG.NO_ROUNDED_CORNERS |
    FLAG.TRANSPARENT_PARENT
  );
});

test('buildAttachPopupFlags({}) returns STEAM_DROPDOWN_FLAGS', () => {
  expect(buildAttachPopupFlags({})).toBe(STEAM_DROPDOWN_FLAGS);
});

test('buildAttachPopupFlags HIDDEN bit always set (created-hidden invariant)', () => {
  const allOff = buildAttachPopupFlags({
    alwaysOnTop: false, nativeBorder: false, noTaskbarIcon: false,
    noWindowShadow: false, noRoundedCorners: false, composited: false,
    transparentParent: false, overrideRedirect: false,
  });
  expect(allOff).toBe(FLAG.HIDDEN);
});

test('buildAttachPopupFlags alwaysOnTop:true sets bit 8192', () => {
  expect(buildAttachPopupFlags({ alwaysOnTop: true }) & FLAG.ALWAYS_ON_TOP).toBe(FLAG.ALWAYS_ON_TOP);
});

test('buildAttachPopupFlags nativeBorder:false clears bit 65536', () => {
  expect(buildAttachPopupFlags({ nativeBorder: false }) & FLAG.NATIVE_BORDER).toBe(0);
});

test('buildAttachPopupFlags overrideRedirect:true sets bit 1048576', () => {
  expect(buildAttachPopupFlags({ overrideRedirect: true }) & FLAG.OVERRIDE_REDIRECT).toBe(FLAG.OVERRIDE_REDIRECT);
});

import { STEAM_MODAL_FLAGS, buildOpenWindowFlags } from '../src/relay/popup-flags';

test('STEAM_MODAL_FLAGS = HIDDEN = 2 (matches Steam Новости обновлений exactly)', () => {
  // Adding RESIZABLE flips Windows DWM into "restore-from-taskbar"
  // animation territory; adding COMPOSITED breaks center_on_window +
  // MoveTo. flags=2 alone gives centering + bring-to-front + no
  // animation — same byte as Steam's own news modal.
  expect(STEAM_MODAL_FLAGS).toBe(FLAG.HIDDEN);
  expect(STEAM_MODAL_FLAGS).toBe(2);
});

test('buildOpenWindowFlags({}) returns STEAM_MODAL_FLAGS', () => {
  expect(buildOpenWindowFlags({})).toBe(STEAM_MODAL_FLAGS);
});

test('buildOpenWindowFlags HIDDEN bit always set', () => {
  const allOff = buildOpenWindowFlags({
    resizable: false, noTaskbarIcon: false,
    alwaysOnTop: false, composited: false,
  });
  expect(allOff).toBe(FLAG.HIDDEN);
});

test('buildOpenWindowFlags resizable defaults OFF', () => {
  // RESIZABLE triggers Windows restore-from-taskbar animation; off by
  // default to match Steam's own modals.
  expect(buildOpenWindowFlags({}) & FLAG.RESIZABLE).toBe(0);
});

test('buildOpenWindowFlags resizable:true opts in to OS-resize (animation cost)', () => {
  expect(buildOpenWindowFlags({ resizable: true }) & FLAG.RESIZABLE).toBe(FLAG.RESIZABLE);
});

test('buildOpenWindowFlags noTaskbarIcon:true sets bit 8', () => {
  expect(buildOpenWindowFlags({ noTaskbarIcon: true }) & FLAG.NO_TASKBAR_ICON).toBe(FLAG.NO_TASKBAR_ICON);
});

test('buildOpenWindowFlags alwaysOnTop:true sets bit 8192', () => {
  expect(buildOpenWindowFlags({ alwaysOnTop: true }) & FLAG.ALWAYS_ON_TOP).toBe(FLAG.ALWAYS_ON_TOP);
});

test('buildOpenWindowFlags composited defaults OFF', () => {
  // composited routes Steam to chromeless code-path; off by default
  // for modals so center_on_window + MoveTo work.
  expect(buildOpenWindowFlags({}) & FLAG.COMPOSITED).toBe(0);
});

test('buildOpenWindowFlags composited:true opts in to chromeless path', () => {
  expect(buildOpenWindowFlags({ composited: true }) & FLAG.COMPOSITED).toBe(FLAG.COMPOSITED);
});

test('STEAM_DROPDOWN_FLAGS and STEAM_MODAL_FLAGS share exactly HIDDEN bit', () => {
  // dropdowns: HIDDEN | NO_TASKBAR_ICON | COMPOSITED | NO_WINDOW_SHADOW |
  //   NATIVE_BORDER | NO_ROUNDED_CORNERS | TRANSPARENT_PARENT
  // modals:    RESIZABLE | HIDDEN
  // overlap:   HIDDEN
  expect(STEAM_DROPDOWN_FLAGS & STEAM_MODAL_FLAGS).toBe(FLAG.HIDDEN);
});
