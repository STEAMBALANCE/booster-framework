import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _internal_setBcChannel, _internal_setMwbmStore, _internal_resetRelay,
  _internal_setBridge, _internal_getOurEntries,
  handleOpen, handleSetUrl, handleClose, handleNativeTitleRequest,
  handleStateRequest,
  setupExternalWindowRelay, teardownExternalWindowRelay,
  computeEffectiveTaskbar,
} from '../src/relay/external-window';
import type { ExternalWindowOpenRequest, ExternalWindowSetUrlRequest } from '../src/relay/protocol';

interface FakeRequest { requestid: number; strURL: string }
interface FakeStore {
  m_rgWebPageRequests: FakeRequest[];
  m_nWebPageRequestID: number;
  m_nActiveWebpageRequestID: number;
  m_cbWebPageRequestsChanged: { Register: (cb: () => void) => () => void };
  AddWebPageRequest: (url: string, makeActive: boolean) => void;
  RemoveWebPageRequest: (id: number) => void;
}

function makeFakeStore(): FakeStore {
  const cbs: Array<() => void> = [];
  const store: FakeStore = {
    m_rgWebPageRequests: [],
    m_nWebPageRequestID: 0,
    m_nActiveWebpageRequestID: 0,
    m_cbWebPageRequestsChanged: {
      Register: (cb) => { cbs.push(cb); return () => { const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1); }; },
    },
    AddWebPageRequest(url: string, makeActive: boolean) {
      const r: FakeRequest = { requestid: ++store.m_nWebPageRequestID, strURL: url };
      store.m_rgWebPageRequests.push(r);
      if (makeActive || store.m_rgWebPageRequests.length === 1) store.m_nActiveWebpageRequestID = r.requestid;
      cbs.forEach(c => c());
    },
    RemoveWebPageRequest(id: number) {
      const idx = store.m_rgWebPageRequests.findIndex(r => r.requestid === id);
      if (idx >= 0) store.m_rgWebPageRequests.splice(idx, 1);
      cbs.forEach(c => c());
    },
  };
  return store;
}

function makeFakeBc() {
  const sent: any[] = [];
  return { sent, bc: { postMessage: (m: any) => sent.push(m) } as any };
}

// Capture+silence console.error around `fn` and assert at least one of the
// captured messages contains `expectedSubstring`. Used for tests that
// intentionally trigger relay error paths (rejected bridge calls, invalid
// inputs, etc.) — we want the relay's diagnostic to fire, but bun-test's
// pretty-printer renders the captured Error stack in a way that LOOKS like
// a test failure. Silencing keeps the test output clean while pinning the
// diagnostic contract.
async function expectConsoleError<T>(
  expectedSubstring: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(a =>
      a instanceof Error ? a.message : typeof a === 'string' ? a : String(a),
    ).join(' '));
  };
  try {
    return await fn();
  } finally {
    console.error = originalError;
    const matched = captured.some(line => line.includes(expectedSubstring));
    if (!matched) {
      // Surface the captured lines so a regression where the diagnostic
      // changed wording (or stopped firing) gives a clear signal.
      throw new Error(
        `expected a console.error containing ${JSON.stringify(expectedSubstring)}; ` +
        `captured: ${JSON.stringify(captured)}`,
      );
    }
  }
}

describe('computeEffectiveTaskbar', () => {
  test('(undefined, undefined) → undefined', () => {
    expect(computeEffectiveTaskbar(undefined, undefined)).toBe(undefined);
  });
  test("('X', undefined) → 'X' (fallback)", () => {
    expect(computeEffectiveTaskbar('X', undefined)).toBe('X');
  });
  test("('X', 'Y') → 'Y' (priority)", () => {
    expect(computeEffectiveTaskbar('X', 'Y')).toBe('Y');
  });
  test("('X', null) → null (opt-out)", () => {
    expect(computeEffectiveTaskbar('X', null)).toBe(null);
  });
  test("(undefined, 'Y') → 'Y' (independent)", () => {
    expect(computeEffectiveTaskbar(undefined, 'Y')).toBe('Y');
  });
  test('(undefined, null) → null (explicit opt-out without title)', () => {
    expect(computeEffectiveTaskbar(undefined, null)).toBe(null);
  });
});

describe('handleOpen', () => {
  let store: FakeStore;
  let bc: { sent: any[]; bc: any };

  beforeEach(() => {
    _internal_resetRelay();
    store = makeFakeStore();
    bc = makeFakeBc();
    _internal_setMwbmStore(store as any);
    _internal_setBcChannel(bc.bc);
  });

  test('valid open posts ok reply with requestId, adds entry, broadcasts state', () => {
    const msg: ExternalWindowOpenRequest = {
      kind: 'external-window-open', requestId: 42, id: 'P', url: 'https://x/', title: 'T',
    };
    handleOpen(msg);
    expect(store.m_rgWebPageRequests).toHaveLength(1);
    expect(store.m_rgWebPageRequests[0]).toMatchObject({ requestid: 1, strURL: 'https://x/' });
    const reply = bc.sent.find(m => m.kind === 'external-window-open-reply');
    expect(reply).toMatchObject({ requestId: 42, ok: true });
    const state = bc.sent.find(m => m.kind === 'external-window-state');
    expect(state.activeIsOurs).toBe(true);
  });

  test('open with already-used id replies ok:false', () => {
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' });
    const reply2idx = bc.sent.length;
    handleOpen({ kind: 'external-window-open', requestId: 2, id: 'P', url: 'https://b/', title: 'T' });
    const reply2 = bc.sent.slice(reply2idx).find(m => m.kind === 'external-window-open-reply');
    expect(reply2).toMatchObject({ requestId: 2, ok: false });
    expect(reply2.error).toMatch(/in use/);
  });

  test('open derives reqId from store diff (NOT m_nWebPageRequestID counter)', () => {
    // Steam (or a test fixture) bumps the counter behind our back:
    store.m_nWebPageRequestID = 100;
    // Add a foreign request first (simulating user's tab):
    store.AddWebPageRequest('https://foreign/', false);  // bumps to 101 internally? Yes, ++m_nWebPageRequestID → 101
    bc.sent.length = 0;  // clear

    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' });
    // Our entry must point to 102 (the new one), not 101 (foreign) or counter pre-add value.
    expect(store.m_rgWebPageRequests).toHaveLength(2);
    // Last request should be ours.
    const last = store.m_rgWebPageRequests[1];
    expect(last.strURL).toBe('https://x/');
    // State broadcast confirms our reqId is 102, not 101.
    const state = bc.sent.find(m => m.kind === 'external-window-state');
    expect(state.ourRequestIds).toEqual([{ id: 'P', reqId: last.requestid, title: 'T' }]);
  });

  test('open with invalid URL replies ok:false', () => {
    handleOpen({ kind: 'external-window-open', requestId: 7, id: 'P', url: 'http://x/', title: 'T' });
    const reply = bc.sent.find(m => m.kind === 'external-window-open-reply');
    expect(reply).toMatchObject({ requestId: 7, ok: false });
    expect(reply.error).toMatch(/https/);
  });

  test('open without MWBM store replies ok:false', () => {
    _internal_setMwbmStore(null);
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' });
    const reply = bc.sent.find(m => m.kind === 'external-window-open-reply');
    expect(reply).toMatchObject({ ok: false });
    expect(reply.error).toMatch(/MWBM/);
  });

  // ── B4: bridge call tests ──────────────────────────────────────────────

  function makeBridgeMock() {
    const calls: Array<{ op: string; args: unknown }> = [];
    let listResult: unknown = { targetIds: [] };
    let injectResult: unknown = {};
    const bridgeMock = {
      call: async (op: string, args: unknown) => {
        calls.push({ op, args });
        if (op === 'listPageTargetIds') return listResult instanceof Error ? Promise.reject(listResult) : listResult;
        if (op === 'injectTabTitleOverride') return injectResult instanceof Error ? Promise.reject(injectResult) : injectResult;
        return {};
      },
    };
    return {
      bridge: bridgeMock,
      calls,
      setListResult: (r: unknown) => { listResult = r; },
      setListReject: (e: Error) => { listResult = e; },
      setInjectReject: (e: Error) => { injectResult = e; },
    };
  }

  test('handleOpen without title — does NOT call bridge', async () => {
    const { bridge, calls } = makeBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 10, id: 'notitle', url: 'https://x/' });
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });

  test('handleOpen with title — calls listPageTargetIds BEFORE injectTabTitleOverride', async () => {
    const { bridge, calls } = makeBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 11, id: 'b4title', url: 'https://x/', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    expect(calls.map(c => c.op)).toEqual(['listPageTargetIds', 'injectTabTitleOverride']);
  });

  test('handleOpen with title — passes priorTargetIds to injectTabTitleOverride', async () => {
    const { bridge, calls, setListResult } = makeBridgeMock();
    setListResult({ targetIds: ['old1', 'old2'] });
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 12, id: 'priortarget', url: 'https://x/', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    const inject = calls.find(c => c.op === 'injectTabTitleOverride');
    expect((inject?.args as any).priorTargetIds).toEqual(['old1', 'old2']);
  });

  // Wire-shape regression guard. Bridge.ts unwraps the native
  // op-worker reply's `resp.result` before resolving the Promise the
  // relay awaits (bridge.ts:47–48). The native side MUST therefore
  // wrap targetIds inside `result`: `{ok:true, result:{targetIds:[…]}}`.
  // makeBridgeMock here simulates the *post-unwrap* shape — what the
  // relay actually sees — so this test pins both the contract and the
  // happy-path priorTargetIds plumbing into a single observable.
  test('handleOpen with title — relay reads targetIds from bridge.call result (post-unwrap shape)', async () => {
    const { bridge, calls, setListResult } = makeBridgeMock();
    // bridge.call resolves to whatever the native side put under `result`
    // (bridge.ts unwraps it). The relay must read `r.targetIds` from
    // exactly this shape, no extra nesting.
    setListResult({ targetIds: ['old1'] });
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 100, id: 'wireshape', url: 'https://x/', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    const inject = calls.find(c => c.op === 'injectTabTitleOverride');
    expect(inject).toBeDefined();
    // priorTargetIds populated → the dedup snapshot is non-empty → wire shape correct.
    expect((inject?.args as any).priorTargetIds).toEqual(['old1']);
  });

  test('handleOpen with title — bridge listPageTargetIds rejects → empty priorTargetIds, still tries inject', async () => {
    const { bridge, calls, setListReject } = makeBridgeMock();
    setListReject(new Error('bridge down'));
    _internal_setBridge(bridge as any);
    await expectConsoleError('listPageTargetIds failed', async () => {
      await handleOpen({ kind: 'external-window-open', requestId: 13, id: 'listreject', url: 'https://x/', title: 'T' });
      await new Promise(r => setTimeout(r, 10));
    });
    const inject = calls.find(c => c.op === 'injectTabTitleOverride');
    expect(inject).toBeDefined();
    expect((inject?.args as any).priorTargetIds).toEqual([]);
  });

  test('handleOpen with title — injectTabTitleOverride rejects → reply was already ok before rejection', async () => {
    const { bridge, setInjectReject } = makeBridgeMock();
    setInjectReject(new Error('inject failed'));
    _internal_setBridge(bridge as any);
    await expectConsoleError('injectTabTitleOverride failed', async () => {
      await handleOpen({ kind: 'external-window-open', requestId: 14, id: 'injectfail', url: 'https://x/', title: 'T' });
      // Let rejection propagate — should NOT throw
      await new Promise(r => setTimeout(r, 10));
    });
    const reply = bc.sent.find(m => m.kind === 'external-window-open-reply' && m.requestId === 14);
    expect(reply).toMatchObject({ ok: true });
  });

  test('handleOpen with title — passes canonicalised URL to AddWebPageRequest AND bridge', async () => {
    const { bridge, calls } = makeBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 15, id: 'canonical', url: 'HTTPS://Example.com', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    // AddWebPageRequest gets the canonical URL
    expect(store.m_rgWebPageRequests[0].strURL).toBe('https://example.com/');
    // Bridge inject also gets canonical
    const inject = calls.find(c => c.op === 'injectTabTitleOverride');
    expect((inject?.args as any).url).toBe('https://example.com/');
  });

  test('handleOpen — placeholder reservation prevents concurrent same-id during bridge await', async () => {
    const { bridge } = makeBridgeMock();
    let resolveList!: (v: any) => void;
    bridge.call = async (op: string) => {
      if (op === 'listPageTargetIds') return new Promise(r => { resolveList = r; });
      return {};
    };
    _internal_setBridge(bridge as any);
    const p1 = handleOpen({ kind: 'external-window-open', requestId: 16, id: 'race', url: 'https://x/', title: 'T' });
    // While p1 awaits listPageTargetIds — fire second handleOpen with same id
    const p2 = handleOpen({ kind: 'external-window-open', requestId: 17, id: 'race', url: 'https://x/' });
    await p2;  // must reply ok:false (id already in use — placeholder)
    const reply2 = bc.sent.find(m => m.kind === 'external-window-open-reply' && m.requestId === 17);
    expect(reply2).toMatchObject({ ok: false });
    expect(reply2.error).toMatch(/in use/);
    // Resolve to let p1 complete cleanly
    resolveList({ targetIds: [] });
    await p1;
  });

  test('handleOpen — placeholder cleaned up if AddWebPageRequest does not surface entry', async () => {
    // Use a store that does NOT add to m_rgWebPageRequests to simulate Steam reject
    const fakeStore = {
      ...store,
      m_rgWebPageRequests: [],
      m_nWebPageRequestID: 0,
      m_nActiveWebpageRequestID: 0,
      m_cbWebPageRequestsChanged: store.m_cbWebPageRequestsChanged,
      AddWebPageRequest: (_url: string, _active: boolean) => { /* no-op: don't add */ },
      RemoveWebPageRequest: (_id: number) => {},
    };
    _internal_setMwbmStore(fakeStore as any);
    const { bridge } = makeBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 18, id: 'cleanfail', url: 'https://x/' });
    expect(_internal_getOurEntries().has('cleanfail')).toBe(false);
    const reply = bc.sent.find(m => m.kind === 'external-window-open-reply' && m.requestId === 18);
    expect(reply).toMatchObject({ ok: false });
  });
});

describe('handleSetUrl', () => {
  let store: FakeStore;
  let bc: { sent: any[]; bc: any };
  beforeEach(() => {
    _internal_resetRelay();
    store = makeFakeStore();
    bc = makeFakeBc();
    _internal_setMwbmStore(store as any);
    _internal_setBcChannel(bc.bc);
  });

  test('updates entry.reqId BEFORE remove (close-detect invariant)', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' });
    bc.sent.length = 0;
    await handleSetUrl({ kind: 'external-window-set-url', id: 'P', url: 'https://b/' });
    // Result: store has only the new request (1 was removed).
    expect(store.m_rgWebPageRequests).toHaveLength(1);
    expect(store.m_rgWebPageRequests[0].strURL).toBe('https://b/');
    // No close-event was emitted — even though reqId 1 disappeared,
    // entry was updated to reqId 2 BEFORE Remove(1) so detect-close
    // saw entry.reqId=2 ∈ {2}.
    const closeEvent = bc.sent.find(m => m.kind === 'external-window-close-event');
    expect(closeEvent).toBeUndefined();
  });

  test('on unknown id is silent no-op', async () => {
    await handleSetUrl({ kind: 'external-window-set-url', id: 'unknown', url: 'https://x/' });
    expect(bc.sent.find(m => m.kind === 'external-window-close-event')).toBeUndefined();
  });

  test('on invalid URL — silent skip + no store change', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' });
    const beforeStore = JSON.stringify(store.m_rgWebPageRequests);
    await expectConsoleError('only https:// allowed', async () => {
      await handleSetUrl({ kind: 'external-window-set-url', id: 'P', url: 'http://insecure/' });
    });
    expect(JSON.stringify(store.m_rgWebPageRequests)).toBe(beforeStore);
  });

  test('after handleSetUrl, broadcasts state with new reqId only', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' });
    bc.sent.length = 0;
    await handleSetUrl({ kind: 'external-window-set-url', id: 'P', url: 'https://b/' });
    const state = bc.sent.find((m: any) => m.kind === 'external-window-state');
    expect(state).toBeDefined();
    expect(state.shellRequestIds).toEqual([store.m_rgWebPageRequests[0].requestid]);
    expect(state.activeIsOurs).toBe(true);
  });

  // ── B5: async + bridge recheck tests ─────────────────────────────────────

  function makeSetUrlBridgeMock() {
    const calls: Array<{ op: string; args: unknown }> = [];
    let listImpl: (op: string, args: unknown) => Promise<unknown> = async () => ({ targetIds: [] });
    const bridgeMock = {
      call: async (op: string, args: unknown) => {
        calls.push({ op, args });
        return listImpl(op, args);
      },
    };
    return {
      bridge: bridgeMock,
      calls,
      callsClear: () => { calls.length = 0; },
      setListImpl: (fn: typeof listImpl) => { listImpl = fn; },
    };
  }

  test('handleSetUrl with title — re-calls injectTabTitleOverride with same title, new url', async () => {
    const { bridge, calls, callsClear } = makeSetUrlBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'x', url: 'https://a/', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    callsClear();
    await handleSetUrl({ kind: 'external-window-set-url', id: 'x', url: 'https://b/' });
    await new Promise(r => setTimeout(r, 10));
    const inject = calls.find(c => c.op === 'injectTabTitleOverride');
    expect(inject).toBeDefined();
    expect((inject?.args as any).title).toBe('T');
    expect((inject?.args as any).url).toBe('https://b/');
  });

  test('handleSetUrl without title — does NOT call bridge', async () => {
    const { bridge, calls, callsClear } = makeSetUrlBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'x', url: 'https://a/' });
    await new Promise(r => setTimeout(r, 10));
    callsClear();
    await handleSetUrl({ kind: 'external-window-set-url', id: 'x', url: 'https://b/' });
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });

  test('handleSetUrl — AddWebPageRequest fails to surface → ourEntries.delete + close-event', async () => {
    const { bridge } = makeSetUrlBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'x', url: 'https://a/', title: 'T' });
    // Swap store for one that doesn't surface new requests
    const nonSurfacingStore = {
      ...store,
      m_rgWebPageRequests: store.m_rgWebPageRequests.slice(),
      m_nActiveWebpageRequestID: store.m_nActiveWebpageRequestID,
      m_cbWebPageRequestsChanged: store.m_cbWebPageRequestsChanged,
      AddWebPageRequest: (_url: string, _active: boolean) => { /* no-op: don't add */ },
      RemoveWebPageRequest: (_id: number) => {},
    };
    _internal_setMwbmStore(nonSurfacingStore as any);
    bc.sent.length = 0;
    await expectConsoleError('new request not surfaced', async () => {
      await handleSetUrl({ kind: 'external-window-set-url', id: 'x', url: 'https://b/' });
    });
    expect(_internal_getOurEntries().has('x')).toBe(false);
    const closeEvent = bc.sent.find(m => m.kind === 'external-window-close-event');
    expect(closeEvent).toMatchObject({ id: 'x' });
  });

  test('handleSetUrl — re-check ourEntries after await; bails if closed during bridge await', async () => {
    const { bridge, setListImpl } = makeSetUrlBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'x', url: 'https://a/', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    // Track AddWebPageRequest calls on the real store
    let addCount = 0;
    const origAdd = store.AddWebPageRequest.bind(store);
    store.AddWebPageRequest = (url: string, active: boolean) => { addCount++; origAdd(url, active); };
    // Slow listPageTargetIds
    let resolveList!: (v: any) => void;
    setListImpl(async (op: string) => {
      if (op === 'listPageTargetIds') return new Promise(r => { resolveList = r; });
      return {};
    });
    const p = handleSetUrl({ kind: 'external-window-set-url', id: 'x', url: 'https://b/' });
    // Simulate close-event during await by removing the entry
    _internal_getOurEntries().delete('x');
    resolveList({ targetIds: [] });
    await p;
    // Should NOT have called AddWebPageRequest (bailed after recheck)
    expect(addCount).toBe(0);
  });

  test('handleSetUrl — bails cleanly if mwbmStore nulled during bridge await (teardown race)', async () => {
    const { bridge, setListImpl } = makeSetUrlBridgeMock();
    _internal_setBridge(bridge as any);
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'x', url: 'https://a/', title: 'T' });
    await new Promise(r => setTimeout(r, 10));
    // Slow listPageTargetIds
    let resolveList!: (v: any) => void;
    setListImpl(async (op: string) => {
      if (op === 'listPageTargetIds') return new Promise(r => { resolveList = r; });
      return {};
    });
    const p = handleSetUrl({ kind: 'external-window-set-url', id: 'x', url: 'https://b/' });
    // Simulate teardown nulling mwbmStore during await
    _internal_setMwbmStore(null);
    resolveList({ targetIds: [] });
    // Must not throw
    await expect(p).resolves.toBeUndefined();
  });
});

describe('broadcastState', () => {
  let store: FakeStore;
  let bc: { sent: any[]; bc: any };

  beforeEach(() => {
    _internal_resetRelay();
    store = makeFakeStore();
    bc = makeFakeBc();
    _internal_setMwbmStore(store as any);
    _internal_setBcChannel(bc.bc);
  });

  function lastBcStateMsg() {
    const msgs = bc.sent.filter(m => m.kind === 'external-window-state');
    return msgs[msgs.length - 1];
  }

  test('placeholder entries (reqId=0) excluded from ourRequestIds', () => {
    // Manually inject a placeholder (reqId=0) and a real entry (reqId=5).
    // We call handleStateRequest to trigger broadcastState directly.
    _internal_getOurEntries().set('p', { id: 'p', reqId: 0, title: undefined, effectiveTaskbar: undefined });
    store.m_rgWebPageRequests = [{ requestid: 5, strURL: 'https://r/' }];
    store.m_nActiveWebpageRequestID = 5;
    _internal_getOurEntries().set('r', { id: 'r', reqId: 5, title: 'T', effectiveTaskbar: 'T' });
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect(ev.ourRequestIds).toHaveLength(1);
    expect(ev.ourRequestIds[0].id).toBe('r');
  });

  test('activeTitle="X" when active entry effectiveTaskbar="X"', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/', title: 'X' });
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect(ev.activeTitle).toBe('X');
    expect('activeTitle' in ev).toBe(true);
  });

  test('activeTitle=null when active entry effectiveTaskbar=null', async () => {
    // taskbarTitle=null → effectiveTaskbar=null
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/', title: 'T', taskbarTitle: null });
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect(ev.activeTitle).toBe(null);
    expect('activeTitle' in ev).toBe(true);
  });

  test('activeTitle key ABSENT when active entry effectiveTaskbar=undefined', async () => {
    // no title, no taskbarTitle → effectiveTaskbar=undefined
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/' });
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect('activeTitle' in ev).toBe(false);
  });

  test('activeTitle absent when foreign tab active (no matching ourEntry)', async () => {
    // Open our entry, then make a foreign request active.
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/', title: 'T' });
    // Inject a foreign request and set it active
    store.m_rgWebPageRequests.push({ requestid: 99, strURL: 'https://foreign/' });
    store.m_nActiveWebpageRequestID = 99;
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect('activeTitle' in ev).toBe(false);
  });

  test('ourRequestIds entries omit title when effectiveTaskbar=undefined', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/' });
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect(ev.ourRequestIds).toHaveLength(1);
    expect('title' in ev.ourRequestIds[0]).toBe(false);
  });

  test('ourRequestIds entries include title when effectiveTaskbar is a string', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/', title: 'T' });
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect(ev.ourRequestIds[0].title).toBe('T');
  });

  test('ourRequestIds entries include title=null when effectiveTaskbar=null', async () => {
    await handleOpen({ kind: 'external-window-open', requestId: 1, id: 'r', url: 'https://x/', title: 'T', taskbarTitle: null });
    bc.sent.length = 0;
    handleStateRequest();
    const ev = lastBcStateMsg();
    expect(ev.ourRequestIds[0].title).toBe(null);
    expect('title' in ev.ourRequestIds[0]).toBe(true);
  });
});

describe('handleClose', () => {
  let store: FakeStore;
  let bc: { sent: any[]; bc: any };
  beforeEach(() => {
    _internal_resetRelay();
    store = makeFakeStore(); bc = makeFakeBc();
    _internal_setMwbmStore(store as any); _internal_setBcChannel(bc.bc);
  });

  test('Removes our request, fires close-event', () => {
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' });
    bc.sent.length = 0;
    handleClose({ kind: 'external-window-close', id: 'P' });
    expect(store.m_rgWebPageRequests).toHaveLength(0);
    const closeEvent = bc.sent.find(m => m.kind === 'external-window-close-event');
    expect(closeEvent).toMatchObject({ id: 'P' });
  });

  test('on unknown id is silent', () => {
    handleClose({ kind: 'external-window-close', id: 'unknown' });
    expect(bc.sent).toHaveLength(0);
  });
});

describe('handleNativeTitleRequest', () => {
  let calls: any[] = [];
  const fakeBridge = { call: async (op: string, args: any) => { calls.push({ op, args }); return { ok: true }; } };

  beforeEach(() => {
    _internal_resetRelay();
    calls = [];
    _internal_setBridge(fakeBridge as any);  // see step 3 — add this hook
  });

  test('valid request → bridge.call(setNativeWindowTitle, ...)', async () => {
    await handleNativeTitleRequest({
      kind: 'external-window-native-title-request',
      title: 'Тест',
      geometry: { x: 100, y: 100, w: 800, h: 600 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'setNativeWindowTitle', args: { title: 'Тест' } });
  });

  test('empty title → silent skip (no bridge call)', async () => {
    await expectConsoleError('invalid title', async () => {
      await handleNativeTitleRequest({
        kind: 'external-window-native-title-request', title: '',
        geometry: { x: 0, y: 0, w: 100, h: 100 },
      });
    });
    expect(calls).toHaveLength(0);
  });

  test('zero geometry → silent skip', async () => {
    await expectConsoleError('invalid geometry', async () => {
      await handleNativeTitleRequest({
        kind: 'external-window-native-title-request', title: 'T',
        geometry: { x: 0, y: 0, w: 0, h: 100 },
      });
    });
    expect(calls).toHaveLength(0);
  });
});

describe('getManifestTabbedShellHints', () => {
  test('returns hints array from globalThis.__SB_PLUGINS_MANIFEST__', () => {
    (globalThis as any).__SB_PLUGINS_MANIFEST__ = { tabbedShellHints: ['._foo123', '._bar456'] };
    _internal_resetRelay();
    const store = makeFakeStore(); const bc = makeFakeBc();
    _internal_setMwbmStore(store as any); _internal_setBcChannel(bc.bc);
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' });
    const state = bc.sent.find((m: any) => m.kind === 'external-window-state');
    expect(state.manifestHints).toEqual(['._foo123', '._bar456']);
    delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
  });

  test('returns empty array when __SB_PLUGINS_MANIFEST__ is absent', () => {
    delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
    _internal_resetRelay();
    const store = makeFakeStore(); const bc = makeFakeBc();
    _internal_setMwbmStore(store as any); _internal_setBcChannel(bc.bc);
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' });
    const state = bc.sent.find((m: any) => m.kind === 'external-window-state');
    expect(state.manifestHints).toEqual([]);
  });

  test('rejects non-string entries (defensive)', () => {
    (globalThis as any).__SB_PLUGINS_MANIFEST__ = { tabbedShellHints: ['._ok', 42, null, ''] };
    _internal_resetRelay();
    const store = makeFakeStore(); const bc = makeFakeBc();
    _internal_setMwbmStore(store as any); _internal_setBcChannel(bc.bc);
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' });
    const state = bc.sent.find((m: any) => m.kind === 'external-window-state');
    expect(state.manifestHints).toEqual(['._ok']);
    delete (globalThis as any).__SB_PLUGINS_MANIFEST__;
  });
});

describe('teardownExternalWindowRelay', () => {
  test('clears subscription, ourEntries, bcChannel', () => {
    _internal_resetRelay();
    const store = makeFakeStore(); const bc = makeFakeBc();
    _internal_setMwbmStore(store as any); _internal_setBcChannel(bc.bc);
    handleOpen({ kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' });
    expect(store.m_rgWebPageRequests).toHaveLength(1);

    teardownExternalWindowRelay();
    // After teardown, subscriber removed (no more onMWBMChange).
    bc.sent.length = 0;
    store.RemoveWebPageRequest(1);  // would normally trigger onMWBMChange → close-event
    expect(bc.sent.length).toBe(0);  // no broadcasts because bcChannel = null
  });
});

describe('setupExternalWindowRelay wiring', () => {
  test('routes BC external-window-open to handleOpen', async () => {
    _internal_resetRelay();
    let cbCaptured: ((e: { data: unknown }) => void) | null = null;
    const fakeBc = {
      postMessage: () => {},
      addEventListener: (_t: string, cb: any) => { cbCaptured = cb; },
    };
    const fakeStore = makeFakeStore();
    const fakeBridge = { call: async () => ({ ok: true }) };
    setupExternalWindowRelay({
      bcChannel: fakeBc as any, mwbmStore: fakeStore as any, bridge: fakeBridge as any,
    });
    cbCaptured!({ data: { kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' } });
    await new Promise(r => setTimeout(r, 10));
    expect(fakeStore.m_rgWebPageRequests).toHaveLength(1);
  });

  test('routes BC external-window-set-url to handleSetUrl', async () => {
    _internal_resetRelay();
    let cb: any = null;
    const fakeBc = { postMessage: () => {}, addEventListener: (_t: string, c: any) => cb = c };
    const fakeStore = makeFakeStore();
    const fakeBridge = { call: async () => ({}) };
    setupExternalWindowRelay({ bcChannel: fakeBc as any, mwbmStore: fakeStore as any, bridge: fakeBridge as any });
    cb({ data: { kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://a/', title: 'T' } });
    await new Promise(r => setTimeout(r, 10));  // let async handleOpen complete
    cb({ data: { kind: 'external-window-set-url', id: 'P', url: 'https://b/' } });
    await new Promise(r => setTimeout(r, 10));  // let async handleSetUrl complete
    expect(fakeStore.m_rgWebPageRequests[0].strURL).toBe('https://b/');
  });

  test('routes BC external-window-native-title-request to bridge.call', async () => {
    _internal_resetRelay();
    let cb: any = null;
    const calls: any[] = [];
    const fakeBc = { postMessage: () => {}, addEventListener: (_t: string, c: any) => cb = c };
    const fakeStore = makeFakeStore();
    const fakeBridge = { call: async (op: string, args: any) => { calls.push({ op, args }); return {}; } };
    setupExternalWindowRelay({ bcChannel: fakeBc as any, mwbmStore: fakeStore as any, bridge: fakeBridge as any });
    cb({ data: { kind: 'external-window-native-title-request', title: 'T', geometry: { x: 0, y: 0, w: 100, h: 100 } } });
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('setNativeWindowTitle');
  });

  test('ignores BC messages with unknown kind', () => {
    _internal_resetRelay();
    let cb: any = null;
    const fakeBc = { postMessage: () => {}, addEventListener: (_t: string, c: any) => cb = c };
    const fakeStore = makeFakeStore();
    const fakeBridge = { call: async () => ({}) };
    setupExternalWindowRelay({ bcChannel: fakeBc as any, mwbmStore: fakeStore as any, bridge: fakeBridge as any });
    expect(() => cb({ data: { kind: 'unknown-kind', foo: 'bar' } })).not.toThrow();
  });

  test('routes BC external-window-state-request to broadcastState', async () => {
    _internal_resetRelay();
    let cb: any = null;
    const fakeBc = { postMessage: (m: any) => fakeBc._sent.push(m), addEventListener: (_t: string, c: any) => cb = c, _sent: [] as any[] };
    const fakeStore = makeFakeStore();
    const fakeBridge = { call: async () => ({}) };
    setupExternalWindowRelay({ bcChannel: fakeBc as any, mwbmStore: fakeStore as any, bridge: fakeBridge as any });
    // First, add a request so state has content.
    cb({ data: { kind: 'external-window-open', requestId: 1, id: 'P', url: 'https://x/', title: 'T' } });
    await new Promise(r => setTimeout(r, 10));  // let async handleOpen complete
    fakeBc._sent.length = 0;  // clear baseline broadcasts.
    // Now request state — should produce a state broadcast.
    cb({ data: { kind: 'external-window-state-request' } });
    const state = fakeBc._sent.find((m: any) => m.kind === 'external-window-state');
    expect(state).toBeDefined();
    expect(state.activeIsOurs).toBe(true);
  });
});
