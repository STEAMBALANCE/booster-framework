// Pure codec for Steam's Store.RegisterCDKey#1 CM ServiceMethod. No SteamClient
// dependency — unit-tested against the byte-exact frame captured live.

const EMSG_SERVICE_METHOD_CALL = 0x80000097; // EMsg 151 | protobuf flag
const JOB_NAME = 'Store.RegisterCDKey#1';

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return out;
}

/** Build the base64 frame for SendMsgAndAwaitBinaryResponse(handle, frame). */
export function encodeRegisterCDKey(key: string): string {
  const enc = new TextEncoder();
  const kb = enc.encode(key);
  const body = [0x0a, ...varint(kb.length), ...kb, 0x18, 0x01]; // {1: key, 3: 1}
  const jn = enc.encode(JOB_NAME);
  const header = [0x62, ...varint(jn.length), ...jn];           // {12: target_job_name}
  const hl = header.length;
  const frame = [
    EMSG_SERVICE_METHOD_CALL & 0xff, (EMSG_SERVICE_METHOD_CALL >>> 8) & 0xff,
    (EMSG_SERVICE_METHOD_CALL >>> 16) & 0xff, (EMSG_SERVICE_METHOD_CALL >>> 24) & 0xff,
    hl & 0xff, (hl >>> 8) & 0xff, (hl >>> 16) & 0xff, (hl >>> 24) & 0xff,
    ...header, ...body,
  ];
  let s = ''; for (const b of frame) s += String.fromCharCode(b);
  return btoa(s);
}

export interface RegisterCDKeyLineItem { packageId: number; appId: number; description: string; }
export interface RegisterCDKeyResponse {
  eresult: number;
  purchaseResultDetails: number;
  transactionId: string;
  lineItems: RegisterCDKeyLineItem[];
}

function readVarint(b: Uint8Array, i: number): [bigint, number] {
  let shift = 0n, val = 0n;
  while (i < b.length) { const c = b[i++]; val |= BigInt(c & 0x7f) << shift; if (!(c & 0x80)) break; shift += 7n; }
  return [val, i];
}

function* scanFields(b: Uint8Array): Generator<{ field: number; wt: number; varint?: bigint; bytes?: Uint8Array }> {
  let i = 0;
  while (i < b.length) {
    let tag: bigint; [tag, i] = readVarint(b, i);
    const field = Number(tag >> 3n), wt = Number(tag & 7n);
    if (wt === 0) { let val: bigint; [val, i] = readVarint(b, i); yield { field, wt, varint: val }; }
    else if (wt === 2) { let len: bigint; [len, i] = readVarint(b, i); const n = Number(len); if (i + n > b.length) return; yield { field, wt, bytes: b.subarray(i, i + n) }; i += n; }
    else if (wt === 5) { i += 4; }
    else if (wt === 1) { i += 8; }
    else return;
  }
}

function topVarint(b: Uint8Array, field: number): bigint | null {
  for (const f of scanFields(b)) if (f.field === field && f.wt === 0) return f.varint!;
  return null;
}
function firstLenDelim(b: Uint8Array, field: number): Uint8Array | null {
  for (const f of scanFields(b)) if (f.field === field && f.wt === 2) return f.bytes!;
  return null;
}
function* allLenDelim(b: Uint8Array, field: number): Generator<Uint8Array> {
  for (const f of scanFields(b)) if (f.field === field && f.wt === 2) yield f.bytes!;
}

function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

export function decodeRegisterCDKeyResponse(bytes: Uint8Array): RegisterCDKeyResponse {
  if (bytes.length < 8) throw new Error('register-cdkey response too short');
  const hdrLen = u32le(bytes, 4);
  if (8 + hdrLen > bytes.length) throw new Error('register-cdkey response header overruns');
  const header = bytes.subarray(8, 8 + hdrLen);
  const body = bytes.subarray(8 + hdrLen);

  const eresult = Number(topVarint(header, 13) ?? 0n);
  const purchaseResultDetails = Number(topVarint(body, 1) ?? 0n);

  let transactionId = '0';
  const lineItems: RegisterCDKeyLineItem[] = [];
  const receipt = firstLenDelim(body, 2);
  if (receipt) {
    const tid = topVarint(receipt, 1);
    if (tid !== null) transactionId = tid.toString();
    const dec = new TextDecoder();
    for (const li of allLenDelim(receipt, 18)) {
      lineItems.push({
        packageId: Number(topVarint(li, 1) ?? 0n),
        appId: Number(topVarint(li, 2) ?? 0n),
        description: (() => { const d = firstLenDelim(li, 3); return d ? dec.decode(d) : ''; })(),
      });
    }
  }
  return { eresult, purchaseResultDetails, transactionId, lineItems };
}
