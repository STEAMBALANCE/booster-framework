import { describe, expect, test } from 'bun:test';
import { validateOpts, validateUrl, _internal_bcRequest, _internal_installReplyRouter, _internal_resetForTest, createExternalWindowApi } from '../src/api/external-window';
import type { OpenExternalWindowHandle, OpenExternalWindowOptions } from '../src/api/api-types';

const goodOpts: OpenExternalWindowOptions = {
  id: 'sb_test',
  url: 'https://example.com/path',
  title: 'Тест',
};

describe('validateOpts', () => {
  test('accepts well-formed opts', () => {
    expect(() => validateOpts(goodOpts)).not.toThrow();
  });

  test('rejects null/undefined', () => {
    expect(() => validateOpts(null as any)).toThrow(/object/);
    expect(() => validateOpts(undefined as any)).toThrow(/object/);
  });

  test('rejects invalid id (empty, too long, special chars)', () => {
    expect(() => validateOpts({ ...goodOpts, id: '' })).toThrow(/id/);
    expect(() => validateOpts({ ...goodOpts, id: 'a'.repeat(65) })).toThrow(/id/);
    expect(() => validateOpts({ ...goodOpts, id: 'has space' })).toThrow(/id/);
    expect(() => validateOpts({ ...goodOpts, id: 'has.dot' })).toThrow(/id/);
  });

  test('rejects empty / overlong title', () => {
    expect(() => validateOpts({ ...goodOpts, title: '' })).toThrow(/title/);
    expect(() => validateOpts({ ...goodOpts, title: 'x'.repeat(201) })).toThrow(/title/);
  });

  test('rejects non-string title', () => {
    expect(() => validateOpts({ ...goodOpts, title: 42 as any })).toThrow(/title/);
  });

  test('accepts opts with no title', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/' } as any)).not.toThrow();
  });

  test('rejects title === ""', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', title: '' } as any))
      .toThrow(/title/);
  });

  test('accepts taskbarTitle === null', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', taskbarTitle: null } as any))
      .not.toThrow();
  });

  test('accepts taskbarTitle === undefined (omitted) — even when title is set', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', title: 'T' } as any)).not.toThrow();
  });

  test('accepts taskbarTitle === "X"', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', taskbarTitle: 'X' } as any))
      .not.toThrow();
  });

  test('rejects taskbarTitle === ""', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', taskbarTitle: '' } as any))
      .toThrow(/taskbarTitle/);
  });

  test('rejects taskbarTitle.length > 200', () => {
    const long = 'x'.repeat(201);
    expect(() => validateOpts({ id: 'a', url: 'https://x/', taskbarTitle: long } as any))
      .toThrow(/taskbarTitle/);
  });

  test('rejects taskbarTitle === false (wrong type)', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', taskbarTitle: false } as any))
      .toThrow(/taskbarTitle/);
  });

  test('rejects taskbarTitle === 0 (wrong type)', () => {
    expect(() => validateOpts({ id: 'a', url: 'https://x/', taskbarTitle: 0 } as any))
      .toThrow(/taskbarTitle/);
  });
});

describe('validateUrl', () => {
  test('accepts well-formed https URL', () => {
    expect(() => validateUrl('https://example.com/', 'url')).not.toThrow();
  });

  test('rejects http://', () => {
    expect(() => validateUrl('http://example.com/', 'url')).toThrow(/https/);
  });

  test('rejects javascript: / data: / file:', () => {
    expect(() => validateUrl('javascript:alert(1)', 'url')).toThrow(/https/);
    expect(() => validateUrl('data:text/html,<x>', 'url')).toThrow(/https/);
    expect(() => validateUrl('file:///c:/x', 'url')).toThrow(/https/);
  });

  test('rejects userinfo (https://user:pass@host)', () => {
    expect(() => validateUrl('https://user:pass@example.com/', 'url')).toThrow(/userinfo/);
  });

  test('rejects explicit port', () => {
    expect(() => validateUrl('https://example.com:8443/', 'url')).toThrow(/port/);
  });

  test('rejects non-ASCII', () => {
    expect(() => validateUrl('https://example.com/тест', 'url')).toThrow(/ASCII/);
  });

  test('rejects > 2048 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2050);
    expect(() => validateUrl(longUrl, 'url')).toThrow(/long/);
  });
});

describe('bcRequest', () => {
  test('posts message with monotonic requestId, resolves with reply', async () => {
    _internal_resetForTest();
    const sent: any[] = [];
    let registeredCb: ((e: { data: unknown }) => void) | null = null;
    const bc = {
      postMessage: (m: any) => sent.push(m),
      addEventListener: (_t: string, cb: any) => { registeredCb = cb; },
    } as any;
    _internal_installReplyRouter(bc);

    const promise = _internal_bcRequest(bc, { kind: 'external-window-open', id: 'a', url: 'https://x/', title: 't' });
    expect(sent).toHaveLength(1);
    const reqId = sent[0].requestId as number;
    expect(typeof reqId).toBe('number');

    registeredCb!({ data: { kind: 'external-window-open-reply', requestId: reqId, ok: true } });
    const reply = await promise;
    expect(reply.ok).toBe(true);
  });

  test('two concurrent bcRequests get distinct requestIds', async () => {
    _internal_resetForTest();
    const sent: any[] = [];
    let cb: any = null;
    const bc = { postMessage: (m: any) => sent.push(m), addEventListener: (_t: string, c: any) => cb = c } as any;
    _internal_installReplyRouter(bc);
    const p1 = _internal_bcRequest(bc, { kind: 'external-window-open', id: 'a' });
    const p2 = _internal_bcRequest(bc, { kind: 'external-window-open', id: 'b' });
    expect(sent[0].requestId).not.toBe(sent[1].requestId);
    cb({ data: { kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true, label: '1' } });
    cb({ data: { kind: 'external-window-open-reply', requestId: sent[1].requestId, ok: true, label: '2' } });
    expect((await p1).label).toBe('1');
    expect((await p2).label).toBe('2');
  });

  test('rejects on timeout', async () => {
    _internal_resetForTest();
    const sent: any[] = [];
    const bc = { postMessage: (m: any) => sent.push(m), addEventListener: () => {} } as any;
    _internal_installReplyRouter(bc);
    // REQUEST_TIMEOUT_MS is injectable — see Task B3 Step 3 impl. Tests
    // pass a 50ms timeout to avoid 5sec hang. Production default 5000ms.
    const promise = _internal_bcRequest(bc, { kind: 'external-window-open', id: 'a' }, 50);
    await expect(promise).rejects.toThrow(/timeout/);
  });
});

describe('createExternalWindowApi.openExternalWindow', () => {
  function makeFakeBc() {
    const sent: any[] = [];
    let cb: ((e: { data: unknown }) => void) | null = null;
    return {
      sent,
      bc: {
        postMessage: (m: any) => sent.push(m),
        addEventListener: (_t: string, c: any) => cb = c,
      } as any,
      reply: (m: any) => cb!({ data: m }),
    };
  }

  test('rejects sync on invalid opts (does not call BC)', async () => {
    _internal_resetForTest();
    const { bc, sent } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    await expect(api.openExternalWindow({ id: 'bad space', url: 'https://x/', title: 't' }))
      .rejects.toThrow(/id/);
    expect(sent).toHaveLength(0);
  });

  test('posts BC open message with id/url/title and resolves with handle on ok reply', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/', title: 'T' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'external-window-open', id: 'P', url: 'https://x/', title: 'T' });
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true });
    const handle = await promise;
    expect(handle.id).toBe('P');
  });

  test('rejects when relay replies ok:false with error', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/', title: 'T' });
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: false, error: 'id already in use' });
    await expect(promise).rejects.toThrow(/id already in use/);
  });

  test('opens with title sends BC payload with title field', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/', title: 'Hello' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'Hello' });
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true });
    await promise;
  });

  test('opens without title — BC payload has NO title key', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/' });
    expect(sent).toHaveLength(1);
    expect('title' in sent[0]).toBe(false);
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true });
    await promise;
  });

  test('opens with taskbarTitle="Y" — BC payload has taskbarTitle:"Y"', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/', taskbarTitle: 'Y' });
    expect(sent[0]).toMatchObject({ taskbarTitle: 'Y' });
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true });
    await promise;
  });

  test('opens with taskbarTitle=null — BC payload has taskbarTitle:null (key present)', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/', taskbarTitle: null });
    expect('taskbarTitle' in sent[0]).toBe(true);
    expect(sent[0].taskbarTitle).toBe(null);
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true });
    await promise;
  });

  test('opens without taskbarTitle — BC payload has NO taskbarTitle key', async () => {
    _internal_resetForTest();
    const { bc, sent, reply } = makeFakeBc();
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://x/' });
    expect('taskbarTitle' in sent[0]).toBe(false);
    reply({ kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true });
    await promise;
  });
});

describe('OpenExternalWindowHandle', () => {
  // Async — properly awaits the open promise; no Promise/sync mismatch
  // and no race on `handle = null as any`.
  async function setupHandle(): Promise<{
    handle: OpenExternalWindowHandle;
    sent: any[];
    reply: (m: any) => void;
    removedListeners: any[];
  }> {
    _internal_resetForTest();
    const sent: any[] = [];
    const removedListeners: any[] = [];
    let cb: any = null;
    const bc = {
      postMessage: (m: any) => sent.push(m),
      addEventListener: (_: string, c: any) => cb = c,
      removeEventListener: (_: string, c: any) => removedListeners.push(c),
    } as any;
    const api = createExternalWindowApi({ bcChannel: bc });
    const promise = api.openExternalWindow({ id: 'P', url: 'https://a/', title: 'T' });
    // BC reply must be fired AFTER the request was posted, BEFORE we await.
    cb({ data: { kind: 'external-window-open-reply', requestId: sent[0].requestId, ok: true } });
    const handle = await promise;
    return { handle, sent, reply: (m: any) => cb({ data: m }), removedListeners };
  }

  test('setUrl posts BC external-window-set-url with id+url, validates URL', async () => {
    const { handle, sent } = await setupHandle();
    handle.setUrl('https://b/');
    expect(sent[1]).toMatchObject({ kind: 'external-window-set-url', id: 'P', url: 'https://b/' });
  });

  test('setUrl throws sync on invalid URL (does not post)', async () => {
    const { handle, sent } = await setupHandle();
    expect(() => handle.setUrl('javascript:alert(1)')).toThrow(/https/);
    expect(sent.filter(m => m.kind === 'external-window-set-url')).toHaveLength(0);
  });

  test('close posts BC external-window-close with id', async () => {
    const { handle, sent } = await setupHandle();
    handle.close();
    expect(sent[1]).toMatchObject({ kind: 'external-window-close', id: 'P' });
  });

  test('on(close) cb fires once when external-window-close-event id matches', async () => {
    const { handle, reply } = await setupHandle();
    const fires: number[] = [];
    handle.on('close', () => fires.push(Date.now()));
    reply({ kind: 'external-window-close-event', id: 'P' });
    expect(fires).toHaveLength(1);
    // Second event ignored (already closed).
    reply({ kind: 'external-window-close-event', id: 'P' });
    expect(fires).toHaveLength(1);
  });

  test('on(close) cb does NOT fire for foreign id', async () => {
    const { handle, reply } = await setupHandle();
    let fired = false;
    handle.on('close', () => fired = true);
    reply({ kind: 'external-window-close-event', id: 'OTHER' });
    expect(fired).toBe(false);
  });

  test('after close-event, setUrl/close are silent no-ops', async () => {
    const { handle, sent, reply } = await setupHandle();
    reply({ kind: 'external-window-close-event', id: 'P' });
    const beforeLen = sent.length;
    handle.setUrl('https://x/');
    handle.close();
    expect(sent.length).toBe(beforeLen);
  });

  test('on(close) added AFTER close fires async (queueMicrotask)', async () => {
    const { handle, reply } = await setupHandle();
    reply({ kind: 'external-window-close-event', id: 'P' });
    let fired = false;
    handle.on('close', () => fired = true);
    expect(fired).toBe(false);  // not sync
    await new Promise(r => queueMicrotask(() => r(undefined)));
    expect(fired).toBe(true);
  });

  test('close-event listener is removed from BC after fireClose (no leak)', async () => {
    const { handle, reply, removedListeners } = await setupHandle();
    expect(removedListeners).toHaveLength(0);
    reply({ kind: 'external-window-close-event', id: 'P' });
    // Listener must have been removed so BC won't keep a reference.
    expect(removedListeners).toHaveLength(1);
    // A second close-event must be silently ignored (listener is gone).
    let callCount = 0;
    handle.on('close', () => callCount++);  // already closed → queueMicrotask
    await new Promise(r => queueMicrotask(() => r(undefined)));
    expect(callCount).toBe(1);  // the queued microtask fires once
    // No additional removal from the second event (listener already removed).
    expect(removedListeners).toHaveLength(1);
  });
});
