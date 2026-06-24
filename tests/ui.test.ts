import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';

let win: Window;

// afterEach restores the captured originals — happy-dom's MutationObserver
// otherwise leaks for the rest of the bun worker and poisons later test files
// that stub document.head by hand (e.g. tabbed-shell-controller).
let _origWindow: unknown, _origDocument: unknown, _origMutationObserver: unknown;
beforeEach(() => {
  _origWindow = globalThis.window;
  _origDocument = globalThis.document;
  _origMutationObserver = globalThis.MutationObserver;
  win = new Window();
  // happy-dom 20 doesn't populate window.SyntaxError; its query-selector parser
  // throws if absent. Patch with the JS-builtin so selectors resolve.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error - assign happy-dom Window to globalThis
  globalThis.window = win;
  // @ts-expect-error - document/MutationObserver come from happy-dom Window
  globalThis.document = win.document;
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver;
});
afterEach(() => {
  // @ts-expect-error
  globalThis.window = _origWindow;
  // @ts-expect-error
  globalThis.document = _origDocument;
  // @ts-expect-error
  globalThis.MutationObserver = _origMutationObserver;
});

test('addHeaderButton inserts before notifications via avatarHolder walk-up', async () => {
  // Setup: toolbar with 3 .Focusable items; profile contains .avatarHolder.
  const toolbar = win.document.createElement('div');
  toolbar.id = 'toolbar';
  for (const cls of ['profile', 'notif', 'menu']) {
    const focusable = win.document.createElement('div');
    focusable.className = 'Focusable';
    focusable.setAttribute('data-which', cls);
    if (cls === 'profile') {
      const avatar = win.document.createElement('div');
      avatar.className = 'avatarHolder';
      focusable.appendChild(avatar);
    }
    toolbar.appendChild(focusable);
  }
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-test',
    label: 'Test',
    onClick: () => {},
    placement: 'before-notifications',
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-test');
  expect(btn).toBeTruthy();
  // Last child should still be the menu (booster-test inserted before last child = menu)
  const last = toolbar.lastElementChild;
  expect(last?.getAttribute('data-which')).toBe('menu');
  // Button should sit immediately before last
  expect(last?.previousElementSibling?.id).toBe('booster-test');
});

test('addHeaderButton wears Steam toolbar classes + injects styles once', async () => {
  // Native fidelity contract (PM7): outer div carries `tool-tip-source
  // Focusable`, label sits inside `.booster-toolbar-inner`, and a single
  // versioned <style> tag (`__sb_toolbar_styles_v*`) is appended to
  // head. If a future refactor drops one of these, Steam's keyboard
  // focus + tooltip wiring breaks silently — this test catches it.
  const toolbar = win.document.createElement('div');
  for (const cls of ['profile', 'notif', 'menu']) {
    const focusable = win.document.createElement('div');
    focusable.className = 'Focusable';
    if (cls === 'profile') {
      const avatar = win.document.createElement('div');
      avatar.className = 'avatarHolder';
      focusable.appendChild(avatar);
    }
    toolbar.appendChild(focusable);
  }
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({ id: 'booster-cls', label: 'Пополнить', onClick: () => {} });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-cls') as HTMLElement | null;
  expect(btn).toBeTruthy();
  expect(btn?.classList.contains('Focusable')).toBe(true);
  expect(btn?.classList.contains('tool-tip-source')).toBe(true);
  expect(btn?.getAttribute('data-booster-btn')).toBe('');
  // Label DOM moved out of <span> into .booster-toolbar-inner.
  const inner = btn?.querySelector('.booster-toolbar-inner');
  expect(inner?.textContent).toBe('Пополнить');

  // Style tag injected exactly once, with the versioned id.
  const styles = win.document.head.querySelectorAll('style[id^="__sb_toolbar_styles_"]');
  expect(styles.length).toBe(1);
  // The version suffix bumps when CSS rules change — keep test pinned to
  // the SAME id ensureToolbarStyles uses today, so a future bump is a
  // single-line update here that documents the rule change.
  // After length-1 assertion above, styles[0] is defined; non-null asserted
  // and cast through unknown because Element → HTMLElement isn't directly
  // assignable under tsc's narrowing rules.
  expect((styles[0]! as unknown as HTMLElement).id).toBe('__sb_toolbar_styles_v9');

  // Re-call addHeaderButton — style tag is still exactly one (idempotent).
  ui.addHeaderButton({ id: 'booster-cls-2', label: 'Other', onClick: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  expect(win.document.head.querySelectorAll('style[id^="__sb_toolbar_styles_"]').length).toBe(1);
});

test('setEnabled toggles aria-disabled, tabindex, and pointer-events together', async () => {
  // PM7 review M-2: aria-disabled alone leaves the button focusable;
  // tabindex="-1" pulls it out of the keyboard tab order. M-3: pointerEvents
  // 'none' is the actual click guard (the CSS cursor rule is cosmetic).
  // All three must flip together; partial enabling is a regression.
  const toolbar = win.document.createElement('div');
  for (const cls of ['profile', 'notif', 'menu']) {
    const f = win.document.createElement('div');
    f.className = 'Focusable';
    if (cls === 'profile') {
      const a = win.document.createElement('div');
      a.className = 'avatarHolder';
      f.appendChild(a);
    }
    toolbar.appendChild(f);
  }
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  const handle = ui.addHeaderButton({ id: 'booster-en', label: 'X', onClick: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  const found = toolbar.querySelector('#booster-en');
  expect(found).not.toBeNull();
  // Non-null asserted after the toBeNull guard above; cast through unknown
  // since Element → HTMLElement isn't directly assignable.
  const btn = found! as unknown as HTMLElement;

  expect(btn.getAttribute('aria-disabled')).toBeNull();
  expect(btn.getAttribute('tabindex')).toBeNull();

  handle.setEnabled(false);
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('tabindex')).toBe('-1');
  expect(btn.style.pointerEvents).toBe('none');

  handle.setEnabled(true);
  expect(btn.getAttribute('aria-disabled')).toBeNull();
  expect(btn.getAttribute('tabindex')).toBeNull();
  expect(btn.style.pointerEvents).toBe('');
});

test('addHeaderButton handle.remove() detaches the button', async () => {
  const toolbar = win.document.createElement('div');
  for (const cls of ['profile', 'notif', 'menu']) {
    const focusable = win.document.createElement('div');
    focusable.className = 'Focusable';
    if (cls === 'profile') {
      const avatar = win.document.createElement('div');
      avatar.className = 'avatarHolder';
      focusable.appendChild(avatar);
    }
    toolbar.appendChild(focusable);
  }
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  const handle = ui.addHeaderButton({ id: 'booster-rm', label: 'X', onClick: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  expect(toolbar.querySelector('#booster-rm')).toBeTruthy();
  handle.remove();
  expect(toolbar.querySelector('#booster-rm')).toBeFalsy();
});

test('addHeaderButton aborts insert when registry rolls back during waitForToolbar', async () => {
  // Toolbar absent at addHeaderButton time → waitForToolbar pends on
  // MutationObserver. We rollbackAll() before the toolbar appears, then
  // mount it: button must NOT appear (the insert path bailed via aborted flag).
  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  // Toolbar not yet in DOM: waitForToolbar will wait on the MutationObserver.
  ui.addHeaderButton({ id: 'booster-race', label: 'Race', onClick: () => {} });

  // Trigger the rollback while waitForToolbar is still pending.
  reg.rollbackAll();

  // Now mount the toolbar. If aborted-flag works, the async insert path
  // bails and the button is never appended.
  const toolbar = win.document.createElement('div');
  for (const cls of ['profile', 'notif', 'menu']) {
    const f = win.document.createElement('div');
    f.className = 'Focusable';
    if (cls === 'profile') {
      const a = win.document.createElement('div');
      a.className = 'avatarHolder';
      f.appendChild(a);
    }
    toolbar.appendChild(f);
  }
  win.document.body.appendChild(toolbar);

  // Give the MutationObserver + microtasks a chance to fire.
  await new Promise((r) => setTimeout(r, 50));

  expect(toolbar.querySelector('#booster-race')).toBeFalsy();
  expect(reg.size()).toBe(0);
});

test('attachPopup posts attach-popup BC and resolves on popup-attached', async () => {
  const { RELAY_CHANNEL } = await import('../src/relay/protocol');
  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');

  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  const fakeRelay = new BroadcastChannel(RELAY_CHANNEL);
  const seen: Array<Record<string, unknown>> = [];
  fakeRelay.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    seen.push(m);
    if (m['kind'] === 'attach-popup') {
      fakeRelay.postMessage({
        kind: 'popup-attached',
        requestId: m['requestId'],
        popupId: m['popupId'],
      });
    }
  });

  const handle = await ui.attachPopup({
    id: 'sb_topup_test',
    html: '<p>x</p>',
    width: 100,
    height: 100,
  });
  // ui-bc registry entry + popup undo entry.
  expect(reg.size()).toBeGreaterThanOrEqual(1);
  expect(handle.isVisible()).toBe(false);
  // Clamped dimensions exposed on handle.
  expect(handle.width).toBe(100);
  expect(handle.height).toBe(100);

  let showFired = 0, hideFired = 0;
  handle.on('show', () => { showFired++; });
  handle.on('hide', () => { hideFired++; });

  // show/hide are fire-and-forget BC posts; visible + listeners are updated
  // ONLY when the relay echoes back popup-show-event / popup-hide-event.
  handle.show({ x: 100, y: 200 });
  // Not yet visible — relay echo hasn't arrived.
  expect(handle.isVisible()).toBe(false);

  // Simulate relay echo: popup-show-event.
  fakeRelay.postMessage({ kind: 'popup-show-event', popupId: 'sb_topup_test' });
  await new Promise((r) => setTimeout(r, 10));
  expect(handle.isVisible()).toBe(true);
  expect(showFired).toBe(1);

  handle.hide();
  expect(handle.isVisible()).toBe(true); // still visible until echo arrives

  // Simulate relay echo: popup-hide-event.
  fakeRelay.postMessage({ kind: 'popup-hide-event', popupId: 'sb_topup_test' });
  await new Promise((r) => setTimeout(r, 10));
  expect(handle.isVisible()).toBe(false);
  expect(hideFired).toBe(1);

  // toggle posts popup-toggle BC (not popup-show/popup-hide directly).
  handle.toggle({ x: 50, y: 60 });
  await new Promise((r) => setTimeout(r, 10));
  const toggleMsg = seen.find((m) => m.kind === 'popup-toggle');
  expect(toggleMsg).toBeDefined();
  expect(toggleMsg?.['x']).toBe(50);
  expect(toggleMsg?.['y']).toBe(60);

  // popup-message routes to handle.on('message')
  let receivedMsg: unknown = undefined;
  handle.on('message', (d) => { receivedMsg = d; });
  fakeRelay.postMessage({ kind: 'popup-message', popupId: 'sb_topup_test', data: { kind: 'navigate', url: 'https://x' } });
  await new Promise((r) => setTimeout(r, 30));
  expect(receivedMsg).toEqual({ kind: 'navigate', url: 'https://x' });

  handle.destroy();

  await new Promise((r) => setTimeout(r, 30));
  const kinds = seen.map((m) => m.kind);
  expect(kinds).toContain('attach-popup');
  expect(kinds).toContain('popup-show');
  expect(kinds).toContain('popup-hide');
  expect(kinds).toContain('popup-toggle');
  expect(kinds).toContain('popup-destroy');

  fakeRelay.close();
});

test('attachPopup rejects invalid id', async () => {
  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');

  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  await expect(ui.attachPopup({
    id: 'bad/id', html: '<p>x</p>', width: 100, height: 100,
  })).rejects.toThrow(/invalid id/);
});

// ── Placement edge cases (Flow 1.12) ─────────────────────────────────────────
//
// These tests pin the full if/else chain in addHeaderButton
// (ui.ts:397-409). Each branch is tested explicitly; the plan wording
// ("'end' placement" and "invalid → before-profile") was incorrect —
// see intent reframe in task 15.12 description. Actual production
// behaviour: invalid/unrecognised values fall through the chain to the
// else branch (toolbar.appendChild), NOT to 'before-profile'.
//
// Existing coverage that is NOT duplicated here:
//  - 'before-notifications' happy path (test on line 19) — covered.
//  - default (no placement) renders before profile (test on line 58) —
//    covers the code path but not positional assertion; Test 1 below
//    adds an explicit 'before-profile' positional assertion.

/** Build a standard [voice, profile(+avatar), notif, menu] toolbar and
 *  attach it to the happy-dom document.  Returns the toolbar element
 *  and the individual .Focusable elements keyed by their data-which. */
function makeToolbar(doc: Document): {
  toolbar: Element;
  items: Record<string, Element>;
} {
  const toolbar = doc.createElement('div');
  toolbar.id = 'toolbar';
  const items: Record<string, Element> = {};
  for (const cls of ['voice', 'profile', 'notif', 'menu']) {
    const focusable = doc.createElement('div');
    focusable.className = 'Focusable';
    focusable.setAttribute('data-which', cls);
    if (cls === 'profile') {
      const avatar = doc.createElement('div');
      avatar.className = 'avatarHolder';
      focusable.appendChild(avatar);
    }
    toolbar.appendChild(focusable);
    items[cls] = focusable;
  }
  doc.body.appendChild(toolbar);
  return { toolbar, items };
}

test("placement 'before-profile' inserts button immediately before the profile focusable", async () => {
  // Intent: explicit 'before-profile' placement lands the button as the
  // direct previousElementSibling of the .Focusable that wraps
  // .avatarHolder (the profile widget). This is the primary user-visible
  // slot — "между колоколом и профилем".
  const { toolbar, items } = makeToolbar(win.document);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-bp',
    label: 'Пополнить',
    onClick: () => {},
    placement: 'before-profile',
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-bp');
  expect(btn).toBeTruthy();
  // Button must sit directly before the profile .Focusable.
  expect(items['profile']?.previousElementSibling?.id).toBe('booster-bp');
  // Voice widget is now before the button (toolbar order: voice → booster-bp → profile → notif → menu).
  expect(btn?.previousElementSibling?.getAttribute('data-which')).toBe('voice');
});

test("placement 'after-profile' inserts button immediately after the profile focusable (nextSibling present)", async () => {
  // Intent: 'after-profile' targets the slot between profile and
  // notifications (nextSibling = notif focusable). toolbar.insertBefore
  // with profileFocusable.nextSibling places the button there.
  const { toolbar, items } = makeToolbar(win.document);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-ap',
    label: 'X',
    onClick: () => {},
    placement: 'after-profile',
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-ap');
  expect(btn).toBeTruthy();
  // Button must sit directly after the profile .Focusable.
  expect(items['profile']?.nextElementSibling?.id).toBe('booster-ap');
  // Notif widget is pushed one slot further right.
  expect(btn?.nextElementSibling?.getAttribute('data-which')).toBe('notif');
});

test("placement 'after-profile' falls back to appendChild when profileFocusable has no nextSibling", async () => {
  // Intent: toolbar has only [profile] — no element after profile.
  // Production code: profileFocusable.nextSibling is null → else branch
  // calls toolbar.appendChild(button), making button the last child.
  //
  // We use a FALLBACK_SELECTORS class so waitForToolbar() finds the
  // element; the structural path requires ≥3 .Focusable children which a
  // single-item toolbar cannot satisfy.
  const toolbar = win.document.createElement('div');
  toolbar.id = 'toolbar-ap-nosibling';
  // Match fallback selector '[class*="topbar_TopBar_"]' in header-selectors.ts.
  toolbar.className = 'topbar_TopBar_FakeSingle';
  const focusable = win.document.createElement('div');
  focusable.className = 'Focusable';
  const avatar = win.document.createElement('div');
  avatar.className = 'avatarHolder';
  focusable.appendChild(avatar);
  toolbar.appendChild(focusable);
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-ap-ns',
    label: 'X',
    onClick: () => {},
    placement: 'after-profile',
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-ap-ns');
  expect(btn).toBeTruthy();
  // Button appended as last child; profile focusable is its previousSibling.
  expect(toolbar.lastElementChild?.id).toBe('booster-ap-ns');
  expect(btn?.previousElementSibling?.className).toContain('Focusable');
});

test("placement 'before-profile' falls through to appendChild when no profileFocusable exists", async () => {
  // Intent: toolbar exists but has no .avatarHolder — so no profileFocusable.
  // The 'before-profile' branch requires profileFocusable; condition false →
  // falls through the if/else chain to the else branch: toolbar.appendChild.
  // Demonstrates that 'before-profile' is NOT the universal fallback —
  // missing DOM → the button appends as last child.
  //
  // We use a FALLBACK_SELECTORS class so waitForToolbar() finds the element
  // even though there is no .avatarHolder/.Focusable structure.
  const toolbar = win.document.createElement('div');
  toolbar.id = 'toolbar-bp-noavatar';
  // Match fallback selector '[class*="topbar_TopBar_"]' in header-selectors.ts.
  toolbar.className = 'topbar_TopBar_FakeClass';
  const a = win.document.createElement('div');
  a.className = 'SomeOtherWidget';
  toolbar.appendChild(a);
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-bp-nf',
    label: 'X',
    onClick: () => {},
    placement: 'before-profile',
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-bp-nf');
  expect(btn).toBeTruthy();
  // No profileFocusable found → falls through to appendChild; button is last child.
  expect(toolbar.lastElementChild?.id).toBe('booster-bp-nf');
});

test('invalid placement string falls through to appendChild (not to before-profile)', async () => {
  // Intent: an unrecognised placement value (e.g. a typo or a future
  // value not yet handled) goes through the full if/else chain without
  // matching any branch and lands in the else: toolbar.appendChild.
  // This is distinct from 'before-profile' behaviour — it does NOT
  // attempt any profile-relative insertion; it unconditionally appends.
  const { toolbar } = makeToolbar(win.document);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-inv',
    label: 'X',
    onClick: () => {},
    // Cast to 'never' to bypass the TS union type guard — simulates
    // runtime misuse or a future placement string not yet in the union.
    placement: 'invalid-string' as never,
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-inv');
  expect(btn).toBeTruthy();
  // Invalid placement → appended as last child, NOT inserted before profile.
  expect(toolbar.lastElementChild?.id).toBe('booster-inv');
  // Profile widget is still in its original slot (not displaced).
  const children = Array.from(toolbar.children);
  const profileIdx = children.findIndex((el) => el.getAttribute('data-which') === 'profile');
  const btnIdx = children.findIndex((el) => el.id === 'booster-inv');
  expect(btnIdx).toBeGreaterThan(profileIdx);
});

test("placement 'before-notifications' with no toolbar children falls back to appendChild", async () => {
  // Intent: 'before-notifications' requires toolbar.lastElementChild.
  // Empty toolbar → lastElementChild is null → condition false → falls
  // through the chain to else: toolbar.appendChild.
  // (The happy-path of this placement is already covered on line 19.)
  //
  // We use a FALLBACK_SELECTORS class so waitForToolbar() finds the element
  // even with no .avatarHolder/.Focusable structure inside.
  const toolbar = win.document.createElement('div');
  toolbar.id = 'toolbar-bn-empty';
  // Match fallback selector '[class*="topbar_TopBar_"]' in header-selectors.ts.
  toolbar.className = 'topbar_TopBar_FakeEmpty';
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  ui.addHeaderButton({
    id: 'booster-bn-empty',
    label: 'X',
    onClick: () => {},
    placement: 'before-notifications',
  });
  await new Promise((r) => setTimeout(r, 50));

  const btn = toolbar.querySelector('#booster-bn-empty');
  expect(btn).toBeTruthy();
  // No siblings at call time → button appended as first-and-last child.
  expect(toolbar.lastElementChild?.id).toBe('booster-bn-empty');
  expect(toolbar.childElementCount).toBe(1);
});

// ── End placement edge cases ───────────────────────────────────────────────

test('addHeaderButton setLabel updates visible text', async () => {
  const toolbar = win.document.createElement('div');
  for (const cls of ['profile', 'notif', 'menu']) {
    const f = win.document.createElement('div');
    f.className = 'Focusable';
    if (cls === 'profile') {
      const a = win.document.createElement('div');
      a.className = 'avatarHolder';
      f.appendChild(a);
    }
    toolbar.appendChild(f);
  }
  win.document.body.appendChild(toolbar);

  const { createRegistry } = await import('../src/registry');
  const { makeUiApi } = await import('../src/api/ui');
  const reg = createRegistry();
  const ui = makeUiApi(reg, { call: async () => ({}) } as never);

  const handle = ui.addHeaderButton({ id: 'booster-lbl', label: 'one', onClick: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  handle.setLabel('two');
  const btn = toolbar.querySelector('#booster-lbl');
  expect(btn?.textContent).toBe('two');
});
