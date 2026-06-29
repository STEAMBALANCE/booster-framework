import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { makeKeysApi, KeyActivationTransportError } from '../src/api/keys';

// Deterministic in-memory BroadcastChannel (overrides the bun global so the
// test controls relay replies precisely).
class FakeBC {
  static channels: FakeBC[] = [];
  listeners = new Set<(ev: MessageEvent) => void>();
  constructor(public name: string) { FakeBC.channels.push(this); }
  postMessage(data: any) { for (const ch of FakeBC.channels) if (ch !== this) for (const l of ch.listeners) l({ data } as MessageEvent); }
  addEventListener(_: string, cb: any) { this.listeners.add(cb); }
  removeEventListener(_: string, cb: any) { this.listeners.delete(cb); }
  close() { this.listeners.clear(); }
}
const fakeRegistry = { push: () => {} } as any;
const origBC = (globalThis as any).BroadcastChannel;

beforeEach(() => { (globalThis as any).BroadcastChannel = FakeBC; FakeBC.channels = []; });
afterEach(() => { (globalThis as any).BroadcastChannel = origBC; FakeBC.channels = []; });

function relay(handler: (key: string, requestId: number) => any) {
  const ch = new FakeBC('sb_cmd');
  ch.addEventListener('message', (ev: any) => {
    const m = ev.data;
    if (m?.kind !== 'activate-product-key') return;
    const reply = handler(m.key, m.requestId);
    if (reply) ch.postMessage(reply);
  });
}

describe('makeKeysApi.activate', () => {
  it('resolves the outcome on activate-product-key-ok', async () => {
    relay((_key, requestId) => ({ kind: 'activate-product-key-ok', requestId, outcome: { ok: true, products: [], transactionId: '1' } }));
    const apiChannelIndex = FakeBC.channels.length; // capture before makeKeysApi allocates its channel
    const api = makeKeysApi(fakeRegistry, undefined, FakeBC as never);
    await expect(api.activate('2QX39-NA5AL-RIFKG')).resolves.toEqual({ ok: true, products: [], transactionId: '1' });
    // After success, the handler must have been removed — no lingering listeners.
    expect(FakeBC.channels[apiChannelIndex].listeners.size).toBe(0);
  });

  it('throws KeyActivationTransportError on activate-product-key-error', async () => {
    relay((_key, requestId) => ({ kind: 'activate-product-key-error', requestId, error: 'disconnected' }));
    const api = makeKeysApi(fakeRegistry, undefined, FakeBC as never);
    await expect(api.activate('X')).rejects.toBeInstanceOf(KeyActivationTransportError);
  });

  it('rejects an empty key without posting', async () => {
    const api = makeKeysApi(fakeRegistry, undefined, FakeBC as never);
    await expect(api.activate('')).rejects.toThrow('invalid product key (empty)');
  });

  it('rejects with KeyActivationTransportError on timeout when no reply arrives', async () => {
    process.env['SB_KEYS_RELAY_TIMEOUT_MS'] = '40';
    new FakeBC('sb_cmd'); // a peer channel that never replies
    const api = makeKeysApi(fakeRegistry, undefined, FakeBC as never);
    await expect(api.activate('X')).rejects.toBeInstanceOf(KeyActivationTransportError);
    delete process.env['SB_KEYS_RELAY_TIMEOUT_MS'];
  });

  it('rejects in-flight activations with KeyActivationTransportError on rollback', async () => {
    // Capture the registry entry so we can trigger undo manually.
    let undoFn: (() => void) | undefined;
    const capturingRegistry = { push: (entry: { description: string; undo: () => void }) => { undoFn = entry.undo; } } as any;
    new FakeBC('sb_cmd'); // peer that never replies
    process.env['SB_KEYS_RELAY_TIMEOUT_MS'] = '60000'; // long timeout so rollback fires first
    const api = makeKeysApi(capturingRegistry);
    const activation = api.activate('X');
    // Trigger rollback immediately (simulates framework teardown).
    undoFn!();
    await expect(activation).rejects.toBeInstanceOf(KeyActivationTransportError);
    delete process.env['SB_KEYS_RELAY_TIMEOUT_MS'];
  });
});
