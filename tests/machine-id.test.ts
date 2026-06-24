import { describe, beforeEach, expect, test } from 'bun:test';
import { parseMachineIdBlob, handleGetMachineId, __resetMachineIdCacheForTest } from '../src/relay/machine-id';

// Build a Valve-binary MessageObject blob: 0x00 <"MessageObject"\0>
// then 0x01 <key\0><value\0> pairs, terminated by 0x08.
function buildBlob(fields: Record<string, string>): ArrayBuffer {
  const bytes: number[] = [];
  const cstr = (s: string) => { for (const c of s) bytes.push(c.charCodeAt(0)); bytes.push(0); };
  bytes.push(0x00); cstr('MessageObject');
  for (const [k, v] of Object.entries(fields)) { bytes.push(0x01); cstr(k); cstr(v); }
  bytes.push(0x08);
  return new Uint8Array(bytes).buffer;
}

describe('parseMachineIdBlob', () => {
  test('parses BB3/FF2/3B3 into the triple', () => {
    const blob = buildBlob({ BB3: 'aaaa', FF2: 'bbbb', '3B3': 'cccc' });
    expect(parseMachineIdBlob(blob)).toEqual({ bb3: 'aaaa', ff2: 'bbbb', b3b: 'cccc' });
  });
  test('returns undefined when a field is missing', () => {
    expect(parseMachineIdBlob(buildBlob({ BB3: 'aaaa' }))).toBeUndefined();
  });
  test('returns undefined on a truncated/garbage blob', () => {
    expect(parseMachineIdBlob(new Uint8Array([0x00, 0x01]).buffer)).toBeUndefined();
    expect(parseMachineIdBlob(new ArrayBuffer(0))).toBeUndefined();
  });
});

describe('handleGetMachineId', () => {
  beforeEach(() => { __resetMachineIdCacheForTest(); });

  function fakeBc() {
    const posted: any[] = [];
    return { posted, bc: { postMessage: (m: any) => posted.push(m) } as unknown as BroadcastChannel };
  }

  test('posts the triple when SteamClient resolves', async () => {
    (globalThis as any).window = {
      SteamClient: { Auth: { GetMachineID: async () => buildBlob({ BB3: 'a', FF2: 'b', '3B3': 'c' }) } },
    };
    const { posted, bc } = fakeBc();
    await handleGetMachineId({ kind: 'get-machine-id', requestId: 7 }, bc);
    expect(posted).toEqual([{ kind: 'machine-id-ok', requestId: 7, value: { bb3: 'a', ff2: 'b', b3b: 'c' } }]);
  });

  test('posts undefined when the method is absent', async () => {
    (globalThis as any).window = { SteamClient: {} };
    const { posted, bc } = fakeBc();
    await handleGetMachineId({ kind: 'get-machine-id', requestId: 9 }, bc);
    expect(posted).toEqual([{ kind: 'machine-id-ok', requestId: 9, value: undefined }]);
  });
});
