import { describe, it, expect } from 'bun:test';
import { makeConfigsApi } from '../src/api/configs';
import type { Bridge } from '../src/bridge';

function makeFakeBridge() {
  const calls: Array<{op: string; args: Record<string, unknown>}> = [];
  const results = new Map<string, unknown>();
  const reject = new Map<string, string>();
  const bridge: Bridge = {
    async call<T>(op: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({op, args: args ?? {}});
      const key = `${op}:${JSON.stringify(args ?? {})}`;
      if (reject.has(key)) throw new Error(reject.get(key)!);
      return results.get(op) as T;
    },
  };
  return { bridge, calls, results, reject };
}

describe('sb.configs.read', () => {
  it('forwards to bridge.call("config_read", {name}) and unwraps data', async () => {
    const { bridge, calls, results } = makeFakeBridge();
    results.set('config_read', { data: { hello: 'world' } });
    const cfg = makeConfigsApi(bridge);
    const r = await cfg.read<{hello: string}>('auth');
    expect(r).toEqual({ hello: 'world' });
    expect(calls).toEqual([{op: 'config_read', args: {name: 'auth'}}]);
  });

  it('returns null when bridge returns {data: null}', async () => {
    const { bridge, results } = makeFakeBridge();
    results.set('config_read', { data: null });
    const cfg = makeConfigsApi(bridge);
    expect(await cfg.read('missing')).toBeNull();
  });

  it('rejects with the bridge error string on native error', async () => {
    const { bridge, reject } = makeFakeBridge();
    reject.set('config_read:{"name":"bad/name"}', 'invalid config name');
    const cfg = makeConfigsApi(bridge);
    await expect(cfg.read('bad/name')).rejects.toThrow('invalid config name');
  });

  it('roundtrips a 1KB-ish nested blob shape', async () => {
    const { bridge, results } = makeFakeBridge();
    const nested = { a: { b: { c: 'x'.repeat(900), arr: [1,2,3] } } };
    results.set('config_read', { data: nested });
    const cfg = makeConfigsApi(bridge);
    expect(await cfg.read<typeof nested>('big')).toEqual(nested);
  });
});

describe('sb.configs.write', () => {
  it('forwards to bridge.call("config_write", {name, data})', async () => {
    const { bridge, calls, results } = makeFakeBridge();
    results.set('config_write', { ok: true });
    const cfg = makeConfigsApi(bridge);
    await cfg.write('auth', { token: 'abc' });
    expect(calls).toEqual([{op: 'config_write', args: {name: 'auth', data: {token: 'abc'}}}]);
  });

  it('rejects on bridge error', async () => {
    const { bridge, reject } = makeFakeBridge();
    reject.set('config_write:{"name":"x","data":{}}', 'disk full');
    const cfg = makeConfigsApi(bridge);
    await expect(cfg.write('x', {})).rejects.toThrow('disk full');
  });

  it('roundtrips deeply nested values verbatim', async () => {
    const { bridge, calls, results } = makeFakeBridge();
    results.set('config_write', { ok: true });
    const cfg = makeConfigsApi(bridge);
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    await cfg.write('nested', deep);
    expect(calls[0]!.args.data).toEqual(deep);
  });
});
