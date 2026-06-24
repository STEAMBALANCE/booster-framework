import { encodeRegisterCDKey, decodeRegisterCDKeyResponse } from './register-cdkey-codec';
import { mapResult } from './keys-result';
import type { ActivateProductKeyRequest } from './protocol';
import type { ActivateOutcome } from '../api/api-types';

const SEND_TIMEOUT_MS = 30_000; // authoritative bound (real responses < 2 s)

// The CM connection handle. Empirically (from a native CM probe)
// a freshly AllocateSharedConnection()'d handle never receives the binary
// response — even after the connection reports logged-on via
// RegisterOnLogonInfoChanged — so SendMsgAndAwaitBinaryResponse hangs on it.
// The WebUI's own already-pumped shared connection (a low, stable handle) is
// the only one that works, and is exactly what Steam's in-client "Activate a
// Product" modal uses. We reuse it and never Close it (we don't own it). If
// Steam ever changes this handle, the send times out → a transport error, with
// no silent key consumption.
const WEBUI_SHARED_CONNECTION_HANDLE = 2;

// NB: a timed-out SendMsgAndAwaitBinaryResponse promise keeps running (CM sends
// aren't cancelable); we deliberately do NOT resend (activation is non-idempotent).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// SendMsgAndAwaitBinaryResponse resolves an ArrayBuffer in the live client
// (not a Uint8Array); normalize so the pure codec always gets a Uint8Array.
function toUint8Array(r: ArrayBuffer | Uint8Array): Uint8Array {
  if (r instanceof Uint8Array) return r;
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  return new Uint8Array((r as ArrayBufferView).buffer, (r as ArrayBufferView).byteOffset, (r as ArrayBufferView).byteLength);
}

async function activate(key: string): Promise<ActivateOutcome> {
  const sc = window.SteamClient?.SharedConnection;
  if (typeof sc?.SendMsgAndAwaitBinaryResponse !== 'function') {
    throw new Error('SharedConnection unavailable');
  }
  const frame = encodeRegisterCDKey(key);
  const resp = await withTimeout(
    sc.SendMsgAndAwaitBinaryResponse(WEBUI_SHARED_CONNECTION_HANDLE, frame),
    SEND_TIMEOUT_MS,
    'register-cdkey send timeout',
  );
  return mapResult(decodeRegisterCDKeyResponse(toUint8Array(resp)));
}

export async function handleActivateProductKey(msg: ActivateProductKeyRequest, bc: BroadcastChannel): Promise<void> {
  try {
    const outcome = await activate(msg.key);
    bc.postMessage({ kind: 'activate-product-key-ok', requestId: msg.requestId, outcome });
  } catch (e) {
    bc.postMessage({ kind: 'activate-product-key-error', requestId: msg.requestId, error: e instanceof Error ? e.message : String(e) });
  }
}
