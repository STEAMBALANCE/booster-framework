import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { RELAY_CHANNEL } from '../src/relay/protocol';
import { createRelayChannel, RELAY_SECRET_FIELD } from '../src/relay/channel';
import { createScope } from '../src/api/scope';
import { makeSteamApi } from '../src/api/steam';
import { makeKeysApi, KeyActivationTransportError } from '../src/api/keys';
import { makeUiApi } from '../src/api/ui';
import { createRegistry } from '../src/registry';
import {
  setupExternalWindowRelay, teardownExternalWindowRelay, _internal_resetRelay,
} from '../src/relay/external-window';
import { createExternalWindowApi } from '../src/api/external-window';

const SEC = 'sb_deadbeefcafe1234';
const flush = () => new Promise<void>((r) => setTimeout(r, 30));
const fakeBridge = { call: async () => ({}) } as never;

// ─── Minimal g_PopupManager mock (lifted from relay.test.ts) ────────────────
function installPopupManagerMock(win: Window) {
  const fakeWindow = {
    closed: false,
    document: { open: () => {}, write: () => {}, close: () => {}, hasFocus: () => true },
    SteamClient: { Window: {
      SetHideOnClose: () => {}, HideWindow: () => {}, ShowWindow: () => {},
      MoveTo: () => {}, ResizeTo: () => {}, SetKeyFocus: () => {}, BringToFront: () => {}, Close: () => {},
    } },
    addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {},
  };
  class FakePopup {
    m_popup: typeof fakeWindow | undefined = undefined;
    constructor(public name: string, public params: Record<string, unknown>) {}
    Show(): void { this.m_popup = fakeWindow; }
    Close(): void { fakeWindow.closed = true; }
    BIsClosed(): boolean { return fakeWindow.closed; }
    BIsVisible(): boolean { return false; }
  }
  const cmEntry = {
    m_strName: 'contextmenu_template',
    m_rgParams: { dimensions: { left: 100000, top: 100000, width: 2, height: 1 } },
    constructor: FakePopup as unknown as () => unknown,
  };
  const pm = { m_mapPopups: new Map([['contextmenu_1_uid0', cmEntry]]) };
  // @ts-expect-error - mock
  globalThis.g_PopupManager = pm;
  (win as unknown as { g_PopupManager: unknown }).g_PopupManager = pm;
}

let win: Window;
beforeEach(() => {
  win = new Window();
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  // @ts-expect-error
  globalThis.window = win;
  // @ts-expect-error
  globalThis.document = win.document;
  // @ts-expect-error
  globalThis.SteamClient = {};
  // @ts-expect-error
  globalThis.MainWindowBrowserManager = { LoadURL: () => {} };
  (win as unknown as { SteamClient: unknown }).SteamClient = (globalThis as unknown as { SteamClient: unknown }).SteamClient;
  (win as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager =
    (globalThis as unknown as { MainWindowBrowserManager: unknown }).MainWindowBrowserManager;
});

// ─── steam.ts inbound auth (V3 user-snapshot forgery) ───────────────────────
describe('steam.ts inbound authentication (V3 user-snapshot)', () => {
  test('forged untagged user-snapshot is dropped; tagged is delivered', async () => {
    const api = makeSteamApi(createRegistry(), fakeBridge, SEC);

    const forger = new BroadcastChannel(RELAY_CHANNEL);
    forger.postMessage({ kind: 'user-snapshot', snapshot: { accountName: 'attacker' } });
    await flush();
    expect(api.getCurrentUser()).toBeNull();

    const ch = createRelayChannel(SEC);
    ch.post({ kind: 'user-snapshot', snapshot: { accountName: 'matrix' } });
    await flush();
    expect(api.getCurrentUser()?.accountName).toBe('matrix');

    forger.close();
    ch.close();
  });
});

// ─── relay inbound auth: forged attach-popup dropped ────────────────────────
describe('relay inbound authentication', () => {
  let stop: (() => void) | null = null;
  afterEach(() => { if (stop) { stop(); stop = null; } });

  test('forged untagged attach-popup dropped; tagged processed', async () => {
    installPopupManagerMock(win);
    const { startRelay } = await import('../src/relay/shared-context');
    stop = startRelay(createScope(), { relaySecret: SEC });

    const sink = new BroadcastChannel(RELAY_CHANNEL);
    const replies: Array<Record<string, unknown>> = [];
    sink.addEventListener('message', (e: MessageEvent) => replies.push(e.data as Record<string, unknown>));

    // Forged (untagged) attach — must be dropped (no relay reply). The sink
    // sees the forger's own request echoed, so filter for relay REPLY kinds.
    const isReply = (r: Record<string, unknown>) => r.kind === 'popup-attached' || r.kind === 'popup-attach-error';
    const forger = new BroadcastChannel(RELAY_CHANNEL);
    forger.postMessage({ kind: 'attach-popup', requestId: 1, popupId: 'pluginA__x', width: 100, height: 100, html: '<p/>', hideOnBlur: false });
    await flush();
    expect(replies.find((r) => isReply(r) && r.requestId === 1)).toBeUndefined();

    // Tagged attach — must be processed.
    const ch = createRelayChannel(SEC);
    ch.post({ kind: 'attach-popup', requestId: 2, popupId: 'pluginA__x', width: 100, height: 100, html: '<p/>', hideOnBlur: false });
    await flush();
    expect(replies.find((r) => r.kind === 'popup-attached' && r.requestId === 2)).toBeTruthy();

    forger.close(); sink.close(); ch.close();
  });
});

// ─── popup ownership ────────────────────────────────────────────────────────
describe('relay popup ownership', () => {
  let stop: (() => void) | null = null;
  afterEach(() => { if (stop) { stop(); stop = null; } });

  test('full-id keying: pluginB__main NOT blocked by pluginA__main; owner re-attach allowed', async () => {
    // Ownership is keyed by the FULL popupId, not just the suffix. So
    // pluginA__main and pluginB__main are independent entries — pluginA
    // cannot squat the `main` userKey and deny pluginB's legitimate attach.
    // This test also verifies that the owning plugin can re-attach its own
    // popup (idempotent reuse path).
    installPopupManagerMock(win);
    const { startRelay } = await import('../src/relay/shared-context');
    stop = startRelay(createScope(), { relaySecret: SEC });

    const sink = new BroadcastChannel(RELAY_CHANNEL);
    const replies: Array<Record<string, unknown>> = [];
    sink.addEventListener('message', (e: MessageEvent) => replies.push(e.data as Record<string, unknown>));
    const ch = createRelayChannel(SEC);

    // pluginA claims pluginA__main.
    ch.post({ kind: 'attach-popup', requestId: 1, popupId: 'pluginA__main', width: 100, height: 100, html: '<p>A</p>', hideOnBlur: false });
    await flush();
    expect(replies.find((r) => r.kind === 'popup-attached' && r.requestId === 1)).toBeTruthy();

    // pluginB__main must NOT be blocked by pluginA__main — distinct full ids
    // are distinct popups (defense-in-depth: no cross-plugin userKey squatting).
    ch.post({ kind: 'attach-popup', requestId: 2, popupId: 'pluginB__main', width: 100, height: 100, html: '<p>B</p>', hideOnBlur: false });
    await flush();
    expect(replies.find((r) => r.kind === 'popup-attached' && r.requestId === 2)).toBeTruthy();

    // pluginA re-attaches its own pluginA__main → reuse (owner match) allowed.
    ch.post({ kind: 'attach-popup', requestId: 3, popupId: 'pluginA__main', width: 100, height: 100, html: '<p>A2</p>', hideOnBlur: false });
    await flush();
    expect(replies.find((r) => r.kind === 'popup-attached' && r.requestId === 3)).toBeTruthy();

    sink.close(); ch.close();
  });
});

// ─── carve-out: untrusted C++ tabbed-shell controller ───────────────────────
describe('external-window relay carve-out (untrusted tabbed shell)', () => {
  function makeFakeBc() {
    const sent: any[] = [];
    let cb: ((e: { data: unknown }) => void) | null = null;
    return {
      sent,
      bc: {
        postMessage: (m: any) => sent.push(m),
        addEventListener: (_t: string, c: any) => { cb = c; },
      } as any,
      emit: (data: unknown) => cb!({ data }),
    };
  }

  beforeEach(() => { _internal_resetRelay(); });
  afterEach(() => { teardownExternalWindowRelay(); });

  test('native-title-request accepted UNTAGGED; trusted external-window-open requires tag', async () => {
    const { bc, emit } = makeFakeBc();
    const calls: any[] = [];
    const store = {
      m_rgWebPageRequests: [] as any[], m_nWebPageRequestID: 0, m_nActiveWebpageRequestID: 0,
      m_cbWebPageRequestsChanged: { Register: () => () => {} },
      AddWebPageRequest(url: string) { this.m_rgWebPageRequests.push({ requestid: ++this.m_nWebPageRequestID, strURL: url }); },
      RemoveWebPageRequest() {},
    };
    const bridge = { call: async (op: string, args: any) => { calls.push({ op, args }); return {}; } };
    setupExternalWindowRelay({ bcChannel: bc, mwbmStore: store as any, bridge: bridge as any, relaySecret: SEC });

    // Carve-out kind UNTAGGED → honored.
    emit({ kind: 'external-window-native-title-request', title: 'T', geometry: { x: 0, y: 0, w: 10, h: 10 } });
    await flush();
    expect(calls.find((c) => c.op === 'setNativeWindowTitle')).toBeTruthy();

    // Trusted kind UNTAGGED → dropped (no store add).
    emit({ kind: 'external-window-open', requestId: 9, id: 'P', url: 'https://x/', title: 'T' });
    await flush();
    expect(store.m_rgWebPageRequests).toHaveLength(0);

    // Trusted kind TAGGED → honored.
    emit({ kind: 'external-window-open', requestId: 10, id: 'P', url: 'https://x/', title: 'T', [RELAY_SECRET_FIELD]: SEC });
    await flush();
    expect(store.m_rgWebPageRequests).toHaveLength(1);
  });

  test('outbound external-window-state is NOT tagged (no secret leak to tabbed shell)', async () => {
    const { sent, bc, emit } = makeFakeBc();
    const store = {
      m_rgWebPageRequests: [] as any[], m_nWebPageRequestID: 0, m_nActiveWebpageRequestID: 0,
      m_cbWebPageRequestsChanged: { Register: () => () => {} },
      AddWebPageRequest(url: string) { const r = { requestid: ++this.m_nWebPageRequestID, strURL: url }; this.m_rgWebPageRequests.push(r); this.m_nActiveWebpageRequestID = r.requestid; },
      RemoveWebPageRequest() {},
    };
    const bridge = { call: async () => ({}) };
    setupExternalWindowRelay({ bcChannel: bc, mwbmStore: store as any, bridge: bridge as any, relaySecret: SEC });

    // Tagged open → reply + state broadcast.
    emit({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T', [RELAY_SECRET_FIELD]: SEC });
    await flush();

    const state = sent.find((m) => m.kind === 'external-window-state');
    expect(state).toBeTruthy();
    expect(state[RELAY_SECRET_FIELD]).toBeUndefined();

    // The open-reply, by contrast, IS tagged (trusted main-shell consumer).
    const reply = sent.find((m) => m.kind === 'external-window-open-reply');
    expect(reply).toBeTruthy();
    expect(reply[RELAY_SECRET_FIELD]).toBe(SEC);
  });
});

// ─── round-trip: keys.ts → relay key-activation → keys.ts (both directions) ──
describe('key-activation round-trip authenticated both directions', () => {
  let stop: (() => void) | null = null;
  afterEach(() => { if (stop) { stop(); stop = null; } });

  test('activate request + relay reply both tagged → promise settles via relay (not timeout)', async () => {
    installPopupManagerMock(win);
    // No SharedConnection → relay activate() throws 'SharedConnection unavailable',
    // and posts activate-product-key-error. If the relay reply were untagged
    // (a missed sub-module), keys.ts would drop it and the activate would TIME
    // OUT instead — so a prompt rejection with this exact message proves both
    // directions are tagged and accepted.
    process.env['SB_KEYS_RELAY_TIMEOUT_MS'] = '5000';
    const { startRelay } = await import('../src/relay/shared-context');
    stop = startRelay(createScope(), { relaySecret: SEC });

    const keys = makeKeysApi(createRegistry(), SEC);
    let err: Error | null = null;
    try { await keys.activate('2QX39-NA5AL-RIFKG'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(KeyActivationTransportError);
    expect(err!.message).toMatch(/SharedConnection unavailable/);
    delete process.env['SB_KEYS_RELAY_TIMEOUT_MS'];
  });
});

// ─── ui.ts inbound: tagged required, popup-message carve-out ─────────────────
describe('ui.ts inbound authentication + popup-message carve-out', () => {
  test('attach-popup posted tagged; only tagged popup-attached resolves', async () => {
    const reg = createRegistry();
    const ui = makeUiApi(reg, fakeBridge, SEC);

    const sink = new BroadcastChannel(RELAY_CHANNEL);
    const posted: Array<Record<string, unknown>> = [];
    sink.addEventListener('message', (e: MessageEvent) => posted.push(e.data as Record<string, unknown>));

    const p = ui.attachPopup({ id: 'pluginA__x', html: '<p/>', width: 100, height: 100 });
    await flush();
    const attach = posted.find((m) => m.kind === 'attach-popup');
    expect(attach).toBeTruthy();
    expect(attach![RELAY_SECRET_FIELD]).toBe(SEC);
    const reqId = attach!['requestId'] as number;

    // Untagged reply → dropped (promise still pending).
    const forger = new BroadcastChannel(RELAY_CHANNEL);
    forger.postMessage({ kind: 'popup-attached', requestId: reqId, popupId: 'pluginA__x' });
    await flush();

    // Tagged reply → resolves.
    const ch = createRelayChannel(SEC);
    ch.post({ kind: 'popup-attached', requestId: reqId, popupId: 'pluginA__x' });
    const handle = await p;
    expect(handle.width).toBe(100);

    forger.close(); sink.close(); ch.close();
  });

  test('untagged popup-message is delivered (plugin popup HTML carve-out)', async () => {
    const reg = createRegistry();
    const ui = makeUiApi(reg, fakeBridge, SEC);

    // Capture the attach-popup requestId from the wire.
    const sink = new BroadcastChannel(RELAY_CHANNEL);
    const posted: Array<Record<string, unknown>> = [];
    sink.addEventListener('message', (e: MessageEvent) => posted.push(e.data as Record<string, unknown>));

    const ch = createRelayChannel(SEC);
    const p = ui.attachPopup({ id: 'pluginA__y', html: '<p/>', width: 100, height: 100 });
    await flush();
    const reqId = posted.find((m) => m.kind === 'attach-popup')!['requestId'] as number;
    ch.post({ kind: 'popup-attached', requestId: reqId, popupId: 'pluginA__y' });
    const handle = await p;

    const got: unknown[] = [];
    handle.on('message', (d) => got.push(d));

    // popup HTML posts popup-message WITHOUT the secret (it has none) → must deliver.
    const popup = new BroadcastChannel(RELAY_CHANNEL);
    popup.postMessage({ kind: 'popup-message', popupId: 'pluginA__y', data: { hello: 1 } });
    await flush();
    expect(got).toEqual([{ hello: 1 }]);

    sink.close(); ch.close(); popup.close();
  });

  test('untagged popup-message with matching requestId does NOT evict in-flight attachPopup pending entry', async () => {
    // Regression: before the fix, the BC handler called pending.delete(requestId)
    // BEFORE checking the message kind. An untagged (carve-out) popup-message
    // with a requestId matching an in-flight attachPopup could evict the pending
    // entry; the real popup-attached reply would then find nothing in pending and
    // the caller's await would hang forever (timeout guard also no-ops once
    // pending.has returns false). Fixed by gating pending.delete on reply kinds only.
    const reg = createRegistry();
    const ui = makeUiApi(reg, fakeBridge, SEC);

    const sink = new BroadcastChannel(RELAY_CHANNEL);
    const posted: Array<Record<string, unknown>> = [];
    sink.addEventListener('message', (e: MessageEvent) => posted.push(e.data as Record<string, unknown>));

    // Start an attachPopup RPC — the framework posts attach-popup with a requestId.
    const p = ui.attachPopup({ id: 'pluginA__dos', html: '<p/>', width: 100, height: 100 });
    await flush();
    const reqId = posted.find((m) => m.kind === 'attach-popup')!['requestId'] as number;

    // Untagged popup-message with the SAME requestId — must not evict the pending entry.
    const attacker = new BroadcastChannel(RELAY_CHANNEL);
    attacker.postMessage({ kind: 'popup-message', requestId: reqId, popupId: 'pluginA__dos', data: {} });
    await flush();

    // The legitimate tagged reply must still resolve the promise.
    // Without the fix this await would hang until the 5 s ATTACH_TIMEOUT_MS.
    const ch = createRelayChannel(SEC);
    ch.post({ kind: 'popup-attached', requestId: reqId, popupId: 'pluginA__dos' });
    const handle = await p;
    expect(handle.width).toBe(100);

    attacker.close(); sink.close(); ch.close();
  });
});

// ─── external-window main-shell api: outbound tagged, inbound filtered ───────
describe('api/external-window authentication', () => {
  test('open posts tagged; untagged reply dropped; tagged reply resolves', async () => {
    const sent: any[] = [];
    let cb: ((e: { data: unknown }) => void) | null = null;
    const bc = {
      postMessage: (m: any) => sent.push(m),
      addEventListener: (_t: string, c: any) => { cb = c; },
      removeEventListener: () => {},
    } as any;
    const api = createExternalWindowApi({ bcChannel: bc, relaySecret: SEC });
    const p = api.openExternalWindow({ id: 'P', url: 'https://x/', title: 'T' });
    const open = sent.find((m) => m.kind === 'external-window-open');
    expect(open).toBeTruthy();
    expect(open[RELAY_SECRET_FIELD]).toBe(SEC);
    const reqId = open.requestId as number;

    // Untagged reply → dropped.
    cb!({ data: { kind: 'external-window-open-reply', requestId: reqId, ok: true } });
    await flush();

    // Tagged reply → resolves.
    cb!({ data: { kind: 'external-window-open-reply', requestId: reqId, ok: true, [RELAY_SECRET_FIELD]: SEC } });
    const handle = await p;
    expect(handle.id).toBe('P');
  });
});
