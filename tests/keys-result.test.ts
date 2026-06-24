import { describe, it, expect } from 'bun:test';
import { mapResult } from '../src/relay/keys-result';

describe('mapResult', () => {
  it('maps success (eresult 1, prd 0) to ok with products', () => {
    const r = mapResult({ eresult: 1, purchaseResultDetails: 0, transactionId: '42', lineItems: [{ packageId: 247659, appId: 0, description: 'Impulsion' }] });
    expect(r).toEqual({ ok: true, products: [{ packageId: 247659, name: 'Impulsion' }], transactionId: '42' });
  });

  it('maps prd 15 to already_activated with a message', () => {
    const r = mapResult({ eresult: 2, purchaseResultDetails: 15, transactionId: '0', lineItems: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('already_activated'); expect(r.resultDetail).toBe(15); expect(r.message.length).toBeGreaterThan(0); }
  });

  it('maps eresult=Fail with prd=0 to unavailable (not via the EPRD table)', () => {
    const r = mapResult({ eresult: 2, purchaseResultDetails: 0, transactionId: '0', lineItems: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('unavailable'); expect(r.resultDetail).toBe(0); }
  });

  it('maps an unknown prd to unavailable preserving resultDetail', () => {
    const r = mapResult({ eresult: 2, purchaseResultDetails: 999, transactionId: '0', lineItems: [] });
    if (!r.ok) { expect(r.code).toBe('unavailable'); expect(r.resultDetail).toBe(999); }
  });
});
