import { describe, it, expect, afterEach } from 'bun:test';
import { readAndConsumeSec } from '../src/sec';

const origManifest = (globalThis as Record<string, unknown>).__SB_PLUGINS_MANIFEST__;

afterEach(() => {
  (globalThis as Record<string, unknown>).__SB_PLUGINS_MANIFEST__ = origManifest;
});

function setManifest(sec: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).__SB_PLUGINS_MANIFEST__ = { _sec: sec };
}

describe('readAndConsumeSec', () => {
  it('returns keysActivate when present in _sec', () => {
    setManifest({ frameworkToken: 'tok', keysActivate: 'sb_activate001' });
    const sec = readAndConsumeSec();
    expect(sec.keysActivate).toBe('sb_activate001');
  });

  it('returns undefined keysActivate when absent from _sec', () => {
    setManifest({ frameworkToken: 'tok' });
    const sec = readAndConsumeSec();
    expect(sec.keysActivate).toBeUndefined();
  });

  it('returns all five fields when all present', () => {
    setManifest({
      frameworkToken: 'ftok',
      resolverName: 'sb_res',
      busDispatchName: 'sb_bus',
      relaySecret: 'sb_relay',
      keysActivate: 'sb_keys',
    });
    const sec = readAndConsumeSec();
    expect(sec.frameworkToken).toBe('ftok');
    expect(sec.resolverName).toBe('sb_res');
    expect(sec.busDispatchName).toBe('sb_bus');
    expect(sec.relaySecret).toBe('sb_relay');
    expect(sec.keysActivate).toBe('sb_keys');
  });

  it('ignores non-string keysActivate', () => {
    setManifest({ frameworkToken: 'tok', keysActivate: 42 });
    const sec = readAndConsumeSec();
    expect(sec.keysActivate).toBeUndefined();
  });

  it('deletes _sec after reading', () => {
    setManifest({ frameworkToken: 'tok', keysActivate: 'sb_x' });
    readAndConsumeSec();
    const manifest = (globalThis as Record<string, unknown>).__SB_PLUGINS_MANIFEST__ as Record<string, unknown>;
    expect(manifest['_sec']).toBeUndefined();
  });

  it('returns empty object when manifest missing', () => {
    (globalThis as Record<string, unknown>).__SB_PLUGINS_MANIFEST__ = undefined;
    const sec = readAndConsumeSec();
    expect(sec).toEqual({});
  });
});

describe('readAndConsumeSec: keysPurchase', () => {
  it('returns keysPurchase when present in _sec', () => {
    setManifest({ frameworkToken: 'tok', keysPurchase: 'sb_purchase001' });
    expect(readAndConsumeSec().keysPurchase).toBe('sb_purchase001');
  });
  it('returns undefined keysPurchase when absent from _sec', () => {
    setManifest({ frameworkToken: 'tok' });
    expect(readAndConsumeSec().keysPurchase).toBeUndefined();
  });
});
