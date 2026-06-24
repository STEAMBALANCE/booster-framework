import { describe, it, expect, afterEach } from 'bun:test';
import { handleActivateProductKey } from '../src/relay/key-activation';

// Build a framed success response. Tags are varint-encoded (field 18 = 0x92 0x01).
function successFrame(): Uint8Array {
  const v = (n: number) => { const o: number[] = []; let x = n; while (x > 0x7f) { o.push((x & 0x7f) | 0x80); x >>>= 7; } o.push(x); return o; };
  const ld = (f: number, p: number[]) => [...v((f << 3) | 2), ...v(p.length), ...p];
  const vf = (f: number, val: number) => [...v((f << 3) | 0), ...v(val)];
  const str = (f: number, s: string) => ld(f, [...new TextEncoder().encode(s)]);
  const li = ld(18, [...vf(1, 1), ...vf(2, 0), ...str(3, 'X')]);
  const receipt = [...vf(1, 42), ...vf(3, 1), ...vf(4, 0), ...li];
  const header = vf(13, 1);
  const body = [...vf(1, 0), ...ld(2, receipt)];
  const hl = header.length;
  return Uint8Array.from([0x93, 0, 0, 0x80, hl, 0, 0, 0, ...header, ...body]);
}

const origWindow = (globalThis as any).window;
afterEach(() => { (globalThis as any).window = origWindow; });

function fakeWindow(sendImpl: (h: number, b64: string) => Promise<ArrayBuffer | Uint8Array>) {
  (globalThis as any).window = {
    SteamClient: { SharedConnection: { SendMsgAndAwaitBinaryResponse: sendImpl } },
  };
}

describe('handleActivateProductKey', () => {
  it('posts activate-product-key-ok with mapped outcome on success', async () => {
    // Live SteamClient resolves an ArrayBuffer (not a Uint8Array) — exercise that path.
    fakeWindow(async () => successFrame().buffer as ArrayBuffer);
    const posted: any[] = [];
    const bc = { postMessage: (m: any) => posted.push(m) } as unknown as BroadcastChannel;
    await handleActivateProductKey({ kind: 'activate-product-key', requestId: 7, key: '2QX39-NA5AL-RIFKG' }, bc);
    expect(posted).toHaveLength(1);
    expect(posted[0].kind).toBe('activate-product-key-ok');
    expect(posted[0].requestId).toBe(7);
    expect(posted[0].outcome.ok).toBe(true);
    expect(posted[0].outcome.products).toEqual([{ packageId: 1, name: 'X' }]);
  });

  it('posts activate-product-key-error when the CM send rejects', async () => {
    fakeWindow(async () => { throw new Error('disconnected'); });
    const posted: any[] = [];
    const bc = { postMessage: (m: any) => posted.push(m) } as unknown as BroadcastChannel;
    await handleActivateProductKey({ kind: 'activate-product-key', requestId: 8, key: 'X' }, bc);
    expect(posted[0].kind).toBe('activate-product-key-error');
    expect(posted[0].requestId).toBe(8);
  });

  it('posts activate-product-key-ok with a business-failure outcome (prd 15)', async () => {
    // framed CStore_RegisterCDKey_Response: eresult=2, prd=15, empty receipt
    const v = (n: number) => { const o: number[] = []; let x = n; while (x > 0x7f) { o.push((x & 0x7f) | 0x80); x >>>= 7; } o.push(x); return o; };
    const ld = (f: number, p: number[]) => [...v((f << 3) | 2), ...v(p.length), ...p];
    const vf = (f: number, val: number) => [...v((f << 3) | 0), ...v(val)];
    const receipt = [...vf(1, 0), ...vf(3, 2), ...vf(4, 15)];
    const header = vf(13, 2);
    const body = [...vf(1, 15), ...ld(2, receipt)];
    const failFrame = Uint8Array.from([0x93, 0, 0, 0x80, header.length, 0, 0, 0, ...header, ...body]);
    fakeWindow(async () => failFrame);
    const posted: any[] = [];
    const bc = { postMessage: (m: any) => posted.push(m) } as unknown as BroadcastChannel;
    await handleActivateProductKey({ kind: 'activate-product-key', requestId: 9, key: '2QX39-NA5AL-RIFKG' }, bc);
    expect(posted[0].kind).toBe('activate-product-key-ok');
    expect(posted[0].outcome.ok).toBe(false);
    expect(posted[0].outcome.code).toBe('already_activated');
  });
});
