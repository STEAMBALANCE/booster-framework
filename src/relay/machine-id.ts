import type { GetMachineIdRequest } from './protocol';
import type { RelayPoster } from './channel';
import type { MachineId } from '../api/api-types';

// Steam's Auth.GetMachineID() returns a Valve-binary KeyValues
// "MessageObject" ArrayBuffer: a 0x00 root type byte, the null-terminated
// root name, then 0x01-typed null-terminated key/value string pairs
// (BB3=disk, FF2=mac, 3B3=other), terminated by 0x08. We parse it here
// (relay-side) so only the parsed strings cross the BroadcastChannel.
/** @internal */
export function parseMachineIdBlob(buf: ArrayBuffer): MachineId | undefined {
  try {
    const b = new Uint8Array(buf);
    if (b.length < 2) return undefined;
    let i = 0;
    const readCStr = (): string => {
      let s = '';
      while (i < b.length && b[i] !== 0) { s += String.fromCharCode(b[i]!); i++; }
      if (i < b.length) i++; // skip NUL (only if found)
      return s;
    };
    i++;          // root type byte (0x00)
    readCStr();   // root name ("MessageObject")
    const fields: Record<string, string> = {};
    while (i < b.length) {
      const t = b[i++];
      if (t === 0x08) break;   // end of object
      if (t !== 0x01) break;   // only string fields expected
      const key = readCStr();
      fields[key] = readCStr();
    }
    const bb3 = fields['BB3'], ff2 = fields['FF2'], b3b = fields['3B3'];
    if (!bb3 || !ff2 || !b3b) return undefined;
    return { bb3, ff2, b3b };
  } catch { return undefined; }
}

// Machine id is constant per machine/process and not account-scoped, so a
// hit is cached forever; a miss is not cached (retry on the next call).
let cached: MachineId | undefined = undefined;

/** @internal — test-only: reset the in-module machine-id cache between tests. */
export function __resetMachineIdCacheForTest(): void { cached = undefined; }

export async function handleGetMachineId(msg: GetMachineIdRequest, bc: RelayPoster): Promise<void> {
  if (cached) {
    bc.postMessage({ kind: 'machine-id-ok', requestId: msg.requestId, value: cached });
    return;
  }
  let value: MachineId | undefined;
  try {
    const sc = (window as unknown as { SteamClient?: { Auth?: { GetMachineID?: () => Promise<ArrayBuffer> } } }).SteamClient;
    if (typeof sc?.Auth?.GetMachineID === 'function') {
      value = parseMachineIdBlob(await sc.Auth.GetMachineID());
    }
  } catch { value = undefined; }
  if (value) cached = value;
  bc.postMessage({ kind: 'machine-id-ok', requestId: msg.requestId, value });
}
