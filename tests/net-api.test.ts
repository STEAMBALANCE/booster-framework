import { test, expect } from 'bun:test';
import { makeNetApi } from '../src/api/net';
import type { Bridge } from '../src/bridge';

function fakeBridge(reply: unknown, capture?: (op: string, args: any) => void): Bridge {
  return {
    call: async (op: string, args?: any) => { capture?.(op, args); return reply as any; },
    notify: () => {},
  };
}

test('fetch sends net_fetch with normalized args and maps the response', async () => {
  let seenOp = ''; let seenArgs: any = null;
  const net = makeNetApi(fakeBridge(
    { status: 200, ok: true, headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    (op, args) => { seenOp = op; seenArgs = args; },
  ));
  const r = await net.fetch('https://steambalance.cc/api/x', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 5000,
  });
  expect(seenOp).toBe('net_fetch');
  expect(seenArgs).toEqual({
    url: 'https://steambalance.cc/api/x', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 5000,
  });
  expect(r.ok).toBe(true);
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('application/json');
  expect(await r.text()).toBe('{"a":1}');
  expect(await r.json<{ a: number }>()).toEqual({ a: 1 });
});

test('fetch defaults method to GET and omits undefined fields', async () => {
  let seenArgs: any = null;
  const net = makeNetApi(fakeBridge(
    { status: 204, ok: true, headers: {}, body: '' },
    (_op, args) => { seenArgs = args; },
  ));
  await net.fetch('https://steambalance.cc/api/y');
  expect(seenArgs.method).toBe('GET');
  expect('headers' in seenArgs).toBe(false);
  expect('body' in seenArgs).toBe(false);
  expect('timeoutMs' in seenArgs).toBe(false);
});

test('json() rejects on invalid JSON body', async () => {
  const net = makeNetApi(fakeBridge({ status: 200, ok: true, headers: {}, body: 'not json' }));
  const r = await net.fetch('https://steambalance.cc/api/z');
  await expect(r.json()).rejects.toThrow();
});
