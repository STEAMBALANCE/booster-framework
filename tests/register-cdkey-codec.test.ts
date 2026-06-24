import { describe, it, expect } from 'bun:test';
import { encodeRegisterCDKey, decodeRegisterCDKeyResponse } from '../src/relay/register-cdkey-codec';

// Byte-exact frame captured live from Steam's own modal for this key.
const CAPTURED_TESTKEY_FRAME =
  'lwAAgBcAAABiFVN0b3JlLlJlZ2lzdGVyQ0RLZXkjMQoRMlFYMzktTkE1QUwtUklGS0cYAQ==';

describe('encodeRegisterCDKey', () => {
  it('produces the byte-exact frame Steam itself sends', () => {
    expect(encodeRegisterCDKey('2QX39-NA5AL-RIFKG')).toBe(CAPTURED_TESTKEY_FRAME);
  });

  it('varint-encodes the key length (no 127-byte limit)', () => {
    const longKey = 'A'.repeat(200);
    const b64 = encodeRegisterCDKey(longKey);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // header length = 23; body starts at 8+23=31. body: 0x0a, varint(200)=0xC8 0x01, then 200 key bytes.
    expect(bytes[31]).toBe(0x0a);
    expect(bytes[32]).toBe(0xc8);
    expect(bytes[33]).toBe(0x01);
  });
});

// Synthesizes a framed CStore_RegisterCDKey_Response — no real PII committed.
function v(n: number | bigint): number[] {
  const out: number[] = []; let x = BigInt(n);
  while (x > 0x7fn) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; }
  out.push(Number(x)); return out;
}
function lenDelim(field: number, payload: number[]): number[] {
  return [...v((field << 3) | 2), ...v(payload.length), ...payload];
}
function varintField(field: number, value: number | bigint): number[] {
  return [...v((field << 3) | 0), ...v(value)];
}
function strField(field: number, s: string): number[] {
  return lenDelim(field, [...new TextEncoder().encode(s)]);
}
function lineItem(packageId: number, appId: number, desc: string): number[] {
  return lenDelim(18, [...varintField(1, packageId), ...varintField(2, appId), ...strField(3, desc)]);
}
function buildResponse(opts: {
  eresult: number; prd: number; transactionId: bigint; items: Array<[number, number, string]>;
}): Uint8Array {
  const header = [...varintField(13, opts.eresult)];
  const receipt = [
    ...varintField(1, opts.transactionId),
    ...varintField(3, opts.eresult === 1 ? 1 : 2),
    ...varintField(4, opts.prd),
    ...opts.items.flatMap(([p, a, d]) => lineItem(p, a, d)),
  ];
  const body = [...varintField(1, opts.prd), ...lenDelim(2, receipt)];
  const hl = header.length;
  const emsg = 0x80000093; // EMsg 147 ServiceMethodResponse
  return Uint8Array.from([
    emsg & 0xff, (emsg >>> 8) & 0xff, (emsg >>> 16) & 0xff, (emsg >>> 24) & 0xff,
    hl & 0xff, (hl >>> 8) & 0xff, (hl >>> 16) & 0xff, (hl >>> 24) & 0xff,
    ...header, ...body,
  ]);
}

describe('decodeRegisterCDKeyResponse', () => {
  it('decodes the captured-shape success (Impulsion)', () => {
    const bytes = buildResponse({ eresult: 1, prd: 0, transactionId: 371129137981130574n, items: [[247659, 0, 'Impulsion']] });
    const r = decodeRegisterCDKeyResponse(bytes);
    expect(r.eresult).toBe(1);
    expect(r.purchaseResultDetails).toBe(0);
    expect(r.transactionId).toBe('371129137981130574');
    expect(r.lineItems).toEqual([{ packageId: 247659, appId: 0, description: 'Impulsion' }]);
  });

  it('decodes already-activated failure (prd 15)', () => {
    const bytes = buildResponse({ eresult: 2, prd: 15, transactionId: 0n, items: [] });
    const r = decodeRegisterCDKeyResponse(bytes);
    expect(r.eresult).toBe(2);
    expect(r.purchaseResultDetails).toBe(15);
  });

  it('decodes a multi-line-item bundle', () => {
    const bytes = buildResponse({ eresult: 1, prd: 0, transactionId: 5n, items: [[1, 0, 'A'], [2, 0, 'B']] });
    expect(decodeRegisterCDKeyResponse(bytes).lineItems).toHaveLength(2);
  });

  it('decodes success with zero line items', () => {
    const bytes = buildResponse({ eresult: 1, prd: 0, transactionId: 5n, items: [] });
    expect(decodeRegisterCDKeyResponse(bytes).lineItems).toEqual([]);
  });
});
