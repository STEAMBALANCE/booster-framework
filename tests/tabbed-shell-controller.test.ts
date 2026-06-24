import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The .js source is `.js.in` — CMake configure_file substitutes the
// @SB_INJECTOR_TABBED_SHELL_DEFAULT_TITLE@ placeholder from strings/ru.json.
// Tests substitute manually with the canonical Russian value so they don't
// require a CMake build to run.
//
// These tests reference resources owned by the native injector (its
// tabbed-shell controller/CSS and the root strings file), resolved via the
// relative paths below. They auto-skip when those resources are not present
// so this repo can be developed/CI-tested standalone. To run them locally,
// make the native injector's resources available at the paths below.
const CONTROLLER_PATH = join(__dirname, '../../injector/resources/tabbed_shell_controller.js.in');
const CSS_PATH = join(__dirname, '../../injector/resources/tabbed_shell_chrome_hide.css');
const STRINGS_JSON_PATH = join(__dirname, '../../strings/ru.json');

const SIBLING_RESOURCES_PRESENT =
  existsSync(CONTROLLER_PATH) && existsSync(CSS_PATH) && existsSync(STRINGS_JSON_PATH);

if (!SIBLING_RESOURCES_PRESENT) {
  // Surface a single explanatory line in the bun-test header so CI logs
  // make it obvious why this file's tests are skipped — distinct from a
  // silent test.skip with no reason.
  // eslint-disable-next-line no-console
  console.log(
    '[tabbed-shell-controller.test] native injector resources not found — ' +
      'skipping (expected when running standalone; provide the injector resources to enable)',
  );
}

function loadController(): string {
  let src = readFileSync(CONTROLLER_PATH, 'utf-8');
  const css = readFileSync(CSS_PATH, 'utf-8');
  const strings = JSON.parse(readFileSync(STRINGS_JSON_PATH, 'utf-8'));
  const defaultTitle = strings.injector?.tabbed_shell?.default_title;
  if (typeof defaultTitle !== 'string') {
    throw new Error('strings.injector.tabbed_shell.default_title missing in strings/ru.json');
  }
  return src
    .replace('__CSS_RULES_PLACEHOLDER__', css)
    .replace(/@SB_INJECTOR_TABBED_SHELL_DEFAULT_TITLE@/g, defaultTitle);
}

interface FakeBC {
  postMessage: (m: any) => void;
  addEventListener: (t: string, cb: (e: { data: any }) => void) => void;
  _fire: (data: any) => void;
  _sent: any[];
}

function makeFakeBC(): FakeBC {
  let cb: any = null;
  const sent: any[] = [];
  return {
    postMessage: (m: any) => sent.push(m),
    addEventListener: (_t: string, c: any) => cb = c,
    _fire: (data: any) => cb && cb({ data }),
    _sent: sent,
  };
}

interface SandboxResult {
  fakeBC: FakeBC;
  body: { classList: { items: Set<string>; add(c: string): void; remove(...cs: string[]): void; contains(c: string): boolean } };
  restore: () => void;
}

// Tracks the active sandbox so the file-level afterEach can restore globals
// regardless of whether the test passed or threw.
let currentSandbox: SandboxResult | null = null;

function setupSandbox(): SandboxResult {
  // Save originals so afterEach can restore them and avoid polluting later
  // test files that run in the same bun worker (e.g. ui.test.ts relies on
  // a real BroadcastChannel — leaving a fake stub breaks its BC tests).
  const origWindow = (global as any).window;
  const origDocument = (global as any).document;
  const origBroadcastChannel = (global as any).BroadcastChannel;
  const origMutationObserver = (global as any).MutationObserver;

  // Stub minimal DOM controller needs in TEST mode (no IIFE side-effects:
  // controller's __SB_EW_TEST__ branch returns early).
  const body = { classList: { items: new Set<string>(), add(c: string) { this.items.add(c); }, remove(...cs: string[]) { for (const c of cs) this.items.delete(c); }, contains(c: string) { return this.items.has(c); } } };
  const fakeBC = makeFakeBC();
  (global as any).window = {
    screenX: 100, screenY: 200, outerWidth: 800, outerHeight: 600, innerWidth: 798, innerHeight: 598, devicePixelRatio: 1,
  };
  (global as any).document = {
    body,
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => ({ children: [] }),
    createElement: () => ({ id: '', textContent: '' }),
  };
  // Stub fake BC for requestNativeTitle's STATE_BC.postMessage path
  // — controller in TEST mode uses the stubbed BroadcastChannel constructor,
  // so STATE_BC is the fakeBC returned by this stub.
  (global as any).BroadcastChannel = function(_name: string) { return fakeBC; };
  // No-op MutationObserver. The controller's `ensureTitleObserver` (added
  // for the bug-3 taskbar-title re-assert) calls
  // `new MutationObserver(...).observe(...)` on `document.head` / `<title>`.
  // Pure-function applyState tests don't exercise the observer's callback,
  // so a stub with no-op `observe`/`disconnect` is sufficient. This stub is
  // installed unconditionally — without it, an earlier file in the run
  // (api-types.test.ts) that installs happy-dom's MutationObserver as a
  // global leaks it here, and happy-dom's `observe()` throws on our
  // hand-rolled `document.head` (not a happy-dom node).
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  (global as any).MutationObserver = FakeMutationObserver;

  return {
    fakeBC,
    body,
    restore: () => {
      (global as any).window = origWindow;
      (global as any).document = origDocument;
      (global as any).BroadcastChannel = origBroadcastChannel;
      (global as any).MutationObserver = origMutationObserver;
    },
  };
}

function loadInTestMode(): any {
  // Set test flag BEFORE evaluating controller — controller's IIFE
  // checks __SB_EW_TEST__ and exports __SB_EW_API__ instead of running.
  (globalThis as any).__SB_EW_TEST__ = true;
  delete (globalThis as any).__SB_EW_API__;
  // Use Function constructor (NOT eval) — clearer scope, no implicit
  // strict-mode promotion from module context.
  // tslint:disable-next-line no-new-func
  new Function(loadController())();
  return (globalThis as any).__SB_EW_API__;
}

afterEach(() => {
  delete (globalThis as any).__SB_EW_TEST__;
  delete (globalThis as any).__SB_EW_API__;
  // Restore globals clobbered by setupSandbox — must run after every test
  // so later test files (ui.test.ts etc.) get real BroadcastChannel back.
  if (currentSandbox) {
    currentSandbox.restore();
    currentSandbox = null;
  }
});

describe.skipIf(!SIBLING_RESOURCES_PRESENT)('tabbed-shell controller (pure-function tests via __SB_EW_API__)', () => {
  let sb: SandboxResult;
  let api: any;

  beforeEach(() => {
    sb = setupSandbox();
    currentSandbox = sb;
    api = loadInTestMode();
  });

  function bcPostsForKind(kind: string): any[] {
    return sb.fakeBC._sent.filter((m: any) => m.kind === kind);
  }

  const stateBase = {
    kind: 'external-window-state',
    shellRequestIds: [1], ourRequestIds: [{ id: 'P', reqId: 1, title: 'T' }],
    activeRequestId: 1, activeIsOurs: true, activeOurId: 'P',
    manifestHints: [],
  };

  test('applyState: tabCount=1, ours active → adds booster-ew-solo class', () => {
    api.applyState({
      kind: 'external-window-state',
      shellRequestIds: [1], ourRequestIds: [{ id: 'P', reqId: 1, title: 'T' }],
      activeRequestId: 1, activeIsOurs: true, activeOurId: 'P', activeTitle: 'Тест',
      manifestHints: [],
    });
    expect((sb.body.classList as any).items.has('booster-ew-solo')).toBe(true);
  });

  test('applyState: tabCount=2, ours active → adds booster-ew-active-tabshown, NOT solo', () => {
    api.applyState({
      kind: 'external-window-state',
      shellRequestIds: [1, 2], ourRequestIds: [{ id: 'P', reqId: 2, title: 'T' }],
      activeRequestId: 2, activeIsOurs: true, activeOurId: 'P', activeTitle: 'Тест',
      manifestHints: [],
    });
    expect((sb.body.classList as any).items.has('booster-ew-active-tabshown')).toBe(true);
    expect((sb.body.classList as any).items.has('booster-ew-solo')).toBe(false);
  });

  test('applyState: foreign active in multi-tab (no preceding solo) → no body class, no native-title BC sent', () => {
    // Per bug-2-multi-tab-ux.md: in multi-tab mode we leave taskbar title
    // untouched. Reset is sent ONLY on the solo→multi-tab transition
    // (covered by R3). When the very first applyState arrives with
    // foreign-active multi-tab and no preceding solo state, no
    // requestNativeTitleReset must fire — touching the Steam shell HWND
    // title here would mutate the shared taskbar entry for the user's tabs.
    api.applyState({
      kind: 'external-window-state',
      shellRequestIds: [1, 2], ourRequestIds: [{ id: 'P', reqId: 2, title: 'T' }],
      activeRequestId: 1, activeIsOurs: false, activeOurId: null, activeTitle: null,
      manifestHints: [],
    });
    expect((sb.body.classList as any).items.has('booster-ew-solo')).toBe(false);
    expect((sb.body.classList as any).items.has('booster-ew-active-tabshown')).toBe(false);
    expect(api._getLastSentTitle()).toBe(null);
    expect(bcPostsForKind('external-window-native-title-request')).toHaveLength(0);
  });

  test('requestNativeTitle fires unconditionally (no dedupe — spec bug-3 F1)', () => {
    api.requestNativeTitle('Тест');  // strings-allow-cyrillic
    api.requestNativeTitle('Тест');  // strings-allow-cyrillic
    api.requestNativeTitle('Другое');  // strings-allow-cyrillic
    // No dedupe — Steam React can overwrite document.title between
    // our calls. Three calls → three BC messages.
    const titleMsgs = sb.fakeBC._sent.filter(
      (m: any) => m.kind === 'external-window-native-title-request'
    );
    expect(titleMsgs).toHaveLength(3);
    expect(titleMsgs[0].title).toBe('Тест');  // strings-allow-cyrillic
    expect(titleMsgs[1].title).toBe('Тест');  // strings-allow-cyrillic
    expect(titleMsgs[2].title).toBe('Другое');  // strings-allow-cyrillic
    expect(api._getLastSentTitle()).toBe('Другое');  // strings-allow-cyrillic
  });

  test('getCurrentGeometry uses live window.outerWidth/screenX, not URL params', () => {
    expect(api.getCurrentGeometry()).toEqual({ x: 100, y: 200, w: 800, h: 600 });
  });

  test('getCurrentGeometry scales by devicePixelRatio (Win32 reports physical px)', () => {
    (global as any).window.devicePixelRatio = 1.25;
    expect(api.getCurrentGeometry()).toEqual({ x: 125, y: 250, w: 1000, h: 750 });
    (global as any).window.devicePixelRatio = 1;
  });

  test('applyManifestHints injects rules + idempotent on same hints', () => {
    // Provide a real-ish style element via stub.
    const fakeStyle = { textContent: '/* HINT_START *//* HINT_END */' };
    (global as any).document.getElementById = (id: string) =>
      id === '__sb_ew_chrome_css' ? fakeStyle : null;

    api.applyManifestHints(['._a', '._b']);
    expect(fakeStyle.textContent).toContain('._a');
    expect(fakeStyle.textContent).toContain('._b');

    const afterFirst = fakeStyle.textContent;
    api.applyManifestHints(['._a', '._b']);
    expect(fakeStyle.textContent).toBe(afterFirst);  // dedup — no change
  });

  // ── B7: three-state activeTitle branching ────────────────────────────────

  test("applyState({activeTitle: 'X'}) — calls requestNativeTitle('X')", () => {
    api.applyState({ ...stateBase, activeTitle: 'X' });
    expect(api._getLastSentTitle()).toBe('X');
  });

  test('applyState({activeTitle: null}) — sets native title to "Steam — браузер" (reset)', () => {
    api.applyState({ ...stateBase, activeTitle: null });
    expect(api._getLastSentTitle()).toBe('Steam — браузер');
  });

  test('applyState({}) (no activeTitle key) — does NOT call setNativeWindowTitle', () => {
    api.applyState({ ...stateBase /* no activeTitle key */ });
    expect(bcPostsForKind('external-window-native-title-request')).toHaveLength(0);
  });

  test('absent activeTitle key — does NOT call setNativeWindowTitle (spec bug-3 F1)', () => {
    api.applyState({ ...stateBase /* no activeTitle key */ });
    expect(bcPostsForKind('external-window-native-title-request')).toHaveLength(0);
  });

  test('requestNativeTitleReset fires unconditionally (no dedupe — spec bug-3 F1)', () => {
    api.applyState({ ...stateBase, activeTitle: null });  // sends 'Steam — браузер'
    api.applyState({ ...stateBase, activeTitle: null });  // sends 'Steam — браузер' again
    // Both fire — no dedupe. Symmetric with requestNativeTitle.
    expect(bcPostsForKind('external-window-native-title-request')).toHaveLength(2);
  });

  // ─── F2: MutationObserver on <title> re-assert (spec bug-3 F2) ───

  test('F2: MutationObserver re-asserts title when <title> mutates in solo mode', () => {
    const titleEl = { textContent: 'Пополнение' };  // strings-allow-cyrillic
    let titleObserverInstance: any = null;
    const origMO = (global as any).MutationObserver;
    const origQS = (global as any).document.querySelector;
    (global as any).MutationObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe(_target: any, _opts: any) { titleObserverInstance = this; }
      disconnect() {}
    };
    (global as any).document.querySelector = (sel: string) =>
      sel === 'head title' ? titleEl : null;
    try {
      api.applyState({
        kind: 'external-window-state',
        shellRequestIds: [1], ourRequestIds: [{ id: 'P', reqId: 1 }],
        activeRequestId: 1, activeIsOurs: true, activeOurId: 'P',
        activeTitle: 'Пополнение',  // strings-allow-cyrillic
        manifestHints: [],
      });

      // Simulate Steam React overwriting <title>:
      titleEl.textContent = 'Steam — браузер';  // strings-allow-cyrillic
      expect(titleObserverInstance).not.toBe(null);
      titleObserverInstance.cb();

      const titleMsgs = sb.fakeBC._sent.filter(
        (m: any) => m.kind === 'external-window-native-title-request'
      );
      // First applyState sent 1 (the 'Пополнение' set); observer
      // adds a second (re-assert lastSentTitle).
      expect(titleMsgs.length).toBeGreaterThanOrEqual(2);
      expect(titleMsgs[titleMsgs.length - 1].title).toBe('Пополнение');  // strings-allow-cyrillic
    } finally {
      (global as any).MutationObserver = origMO;
      (global as any).document.querySelector = origQS;
    }
  });

  test('F2: MutationObserver does NOT re-assert in multi-tab mode', () => {
    const titleEl = { textContent: 'Пополнение' };  // strings-allow-cyrillic
    let titleObserverInstance: any = null;
    const origMO = (global as any).MutationObserver;
    const origQS = (global as any).document.querySelector;
    (global as any).MutationObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe() { titleObserverInstance = this; }
      disconnect() {}
    };
    (global as any).document.querySelector = (sel: string) =>
      sel === 'head title' ? titleEl : null;
    try {
      // In multi-tab the body class is booster-ew-active-tabshown, not
      // booster-ew-solo. applyState does NOT fire requestNativeTitle (R2)
      // and ensureTitleObserver isn't installed either. But even if
      // we manually install via the exported helper, the observer's
      // guard requires booster-ew-solo. Verify the guard.
      sb.body.classList.add('booster-ew-active-tabshown');
      api.ensureTitleObserver();
      expect(titleObserverInstance).not.toBe(null);
      titleEl.textContent = 'Steam — браузер';  // strings-allow-cyrillic
      titleObserverInstance.cb();

      // No re-fire (body has booster-ew-active-tabshown, not booster-ew-solo).
      const titleMsgs = sb.fakeBC._sent.filter(
        (m: any) => m.kind === 'external-window-native-title-request'
      );
      expect(titleMsgs).toHaveLength(0);
    } finally {
      (global as any).MutationObserver = origMO;
      (global as any).document.querySelector = origQS;
    }
  });

  test('F2: MutationObserver does NOT re-assert when lastSentTitle is null', () => {
    const titleEl = { textContent: 'Steam — браузер' };  // strings-allow-cyrillic
    let titleObserverInstance: any = null;
    const origMO = (global as any).MutationObserver;
    const origQS = (global as any).document.querySelector;
    (global as any).MutationObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe() { titleObserverInstance = this; }
      disconnect() {}
    };
    (global as any).document.querySelector = (sel: string) =>
      sel === 'head title' ? titleEl : null;
    try {
      // Don't call applyState — no title ever set, lastSentTitle stays null.
      api.ensureTitleObserver();
      expect(titleObserverInstance).not.toBe(null);
      sb.body.classList.add('booster-ew-solo');
      titleEl.textContent = 'Whatever';
      titleObserverInstance.cb();
      expect(bcPostsForKind('external-window-native-title-request')).toHaveLength(0);
    } finally {
      (global as any).MutationObserver = origMO;
      (global as any).document.querySelector = origQS;
    }
  });

  test('R1: multi-tab CSS does not hide toolbar+address', () => {
    const src = loadController();
    expect(src).not.toContain(
      'body.booster-ew-active-tabshown .TabbedPopupBrowser > div:has(input.DialogInput)'
    );
    expect(src).toContain(
      'body.booster-ew-solo .TabbedPopupBrowser > div:has(input.DialogInput)'
    );
  });

  test('R4: manifest hints generate solo-only rules', () => {
    // Use sb/api from beforeEach — do NOT re-call setupSandbox / loadInTestMode
    // here. Calling them twice in one test would save the already-stubbed
    // BroadcastChannel as "original" and afterEach would restore the stub
    // instead of the real one, breaking later test files.
    //
    // applyManifestHints uses document.getElementById('__sb_ew_chrome_css')
    // exclusively — no body class lookup, so no body seeding needed.
    const styleEl = { id: '__sb_ew_chrome_css', textContent: '/* HINT_START *//* HINT_END */' };
    (global as any).document.getElementById = (id: string) =>
      id === '__sb_ew_chrome_css' ? styleEl : null;

    api.applyManifestHints(['.foo', '.bar']);

    expect(styleEl.textContent).toContain('body.booster-ew-solo .foo { display: none !important; }');
    expect(styleEl.textContent).toContain('body.booster-ew-solo .bar { display: none !important; }');
    expect(styleEl.textContent).not.toContain('body.booster-ew-active-tabshown');
  });

  test('R2: multi-tab applyState does not call requestNativeTitle', () => {
    api.applyState({
      kind: 'external-window-state',
      shellRequestIds: [1, 2],
      ourRequestIds: [{ id: 'pay', reqId: 2 }],
      activeRequestId: 2,
      activeIsOurs: true,
      activeOurId: 'pay',
      activeTitle: 'Пополнение',  // strings-allow-cyrillic
      manifestHints: [],
    });
    const titleMsgs = sb.fakeBC._sent.filter(
      (m: any) => m.kind === 'external-window-native-title-request'
    );
    expect(titleMsgs).toHaveLength(0);
  });

  test('R3: solo→multi-tab transition triggers exactly one reset', () => {
    api.applyState({
      kind: 'external-window-state',
      shellRequestIds: [1],
      ourRequestIds: [{ id: 'pay', reqId: 1 }],
      activeRequestId: 1, activeIsOurs: true, activeOurId: 'pay',
      activeTitle: 'Пополнение',  // strings-allow-cyrillic
      manifestHints: [],
    });
    expect(api._getLastWasSolo()).toBe(true);

    api.applyState({
      kind: 'external-window-state',
      shellRequestIds: [1, 2],
      ourRequestIds: [{ id: 'pay', reqId: 1 }],
      activeRequestId: 2,
      activeIsOurs: false, activeOurId: null,
      manifestHints: [],
    });
    expect(api._getLastWasSolo()).toBe(false);

    const titleMsgs = sb.fakeBC._sent.filter(
      (m: any) => m.kind === 'external-window-native-title-request'
    );
    expect(titleMsgs).toHaveLength(2);
    expect(titleMsgs[0].title).toBe('Пополнение');  // strings-allow-cyrillic
    expect(titleMsgs[1].title).toBe('Steam — браузер');  // strings-allow-cyrillic
  });

  // Idempotency: repeated multi-tab applyState (no preceding solo) must not
  // emit ANY native-title BC. Otherwise every broadcastState tick during
  // multi-tab navigation would mutate the user's taskbar entry.
  test('R2b: repeated multi-tab applyState produces zero title messages', () => {
    const multiTabState = {
      kind: 'external-window-state',
      shellRequestIds: [1, 2],
      ourRequestIds: [{ id: 'pay', reqId: 2 }],
      activeRequestId: 2,
      activeIsOurs: true, activeOurId: 'pay',
      activeTitle: 'Пополнение',  // strings-allow-cyrillic
      manifestHints: [],
    };
    api.applyState(multiTabState);
    api.applyState(multiTabState);
    api.applyState(multiTabState);
    const titleMsgs = sb.fakeBC._sent.filter(
      (m: any) => m.kind === 'external-window-native-title-request'
    );
    expect(titleMsgs).toHaveLength(0);
  });

  // Transition reset is one-shot. After solo → multi-tab fires the single
  // reset, subsequent multi-tab states must NOT re-fire it.
  test('R3b: multi-tab state after transition does not re-fire reset', () => {
    const soloState = {
      kind: 'external-window-state',
      shellRequestIds: [1],
      ourRequestIds: [{ id: 'pay', reqId: 1 }],
      activeRequestId: 1, activeIsOurs: true, activeOurId: 'pay',
      activeTitle: 'Пополнение',  // strings-allow-cyrillic
      manifestHints: [],
    };
    const multiTabState = {
      kind: 'external-window-state',
      shellRequestIds: [1, 2],
      ourRequestIds: [{ id: 'pay', reqId: 1 }],
      activeRequestId: 2,
      activeIsOurs: false, activeOurId: null,
      manifestHints: [],
    };
    api.applyState(soloState);
    api.applyState(multiTabState);
    api.applyState(multiTabState);  // third call must be a no-op
    api.applyState(multiTabState);
    const titleMsgs = sb.fakeBC._sent.filter(
      (m: any) => m.kind === 'external-window-native-title-request'
    );
    // Still exactly 2: solo title + transition reset, no more.
    expect(titleMsgs).toHaveLength(2);
  });

  // Reverse transition: multi-tab → solo must restore our title. Locks the
  // most user-facing path (closing the user's last own tab so ours goes solo).
  test('R5: multi-tab → solo transition reapplies our title', () => {
    const soloState = (title: string) => ({
      kind: 'external-window-state',
      shellRequestIds: [1],
      ourRequestIds: [{ id: 'pay', reqId: 1 }],
      activeRequestId: 1, activeIsOurs: true, activeOurId: 'pay',
      activeTitle: title,
      manifestHints: [],
    });
    const multiTabState = {
      kind: 'external-window-state',
      shellRequestIds: [1, 2],
      ourRequestIds: [{ id: 'pay', reqId: 1 }],
      activeRequestId: 2,
      activeIsOurs: false, activeOurId: null,
      manifestHints: [],
    };

    api.applyState(soloState('Пополнение'));      // strings-allow-cyrillic — emits 'Пополнение'
    api.applyState(multiTabState);                // emits default reset
    api.applyState(soloState('Пополнение'));      // strings-allow-cyrillic — re-emits 'Пополнение'

    const titleMsgs = sb.fakeBC._sent.filter(
      (m: any) => m.kind === 'external-window-native-title-request'
    );
    expect(titleMsgs).toHaveLength(3);
    expect(titleMsgs[0].title).toBe('Пополнение');     // strings-allow-cyrillic
    expect(titleMsgs[1].title).toBe('Steam — браузер'); // strings-allow-cyrillic
    expect(titleMsgs[2].title).toBe('Пополнение');     // strings-allow-cyrillic
    expect(api._getLastWasSolo()).toBe(true);
  });
});
