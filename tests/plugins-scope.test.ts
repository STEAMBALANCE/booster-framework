import { test, expect } from 'bun:test';
import { createPluginScope } from '../src/plugins/scope';

test('per-plugin scope aborts when parent aborts', () => {
  const parentCtrl = new AbortController();
  const ps = createPluginScope(parentCtrl.signal, 'booster-test');
  expect(ps.signal.aborted).toBe(false);
  parentCtrl.abort();
  expect(ps.signal.aborted).toBe(true);
});

test('per-plugin scope can abort independently', () => {
  const parentCtrl = new AbortController();
  const ps = createPluginScope(parentCtrl.signal, 'booster-test');
  ps._abort();
  expect(ps.signal.aborted).toBe(true);
  expect(parentCtrl.signal.aborted).toBe(false);
});

test('parent already aborted means plugin scope starts aborted', () => {
  const parentCtrl = new AbortController();
  parentCtrl.abort();
  const ps = createPluginScope(parentCtrl.signal, 'booster-test');
  expect(ps.signal.aborted).toBe(true);
});

test('per-plugin scope has full ScopeApi (setTimeout/setInterval/listen/fetch)', () => {
  const parentCtrl = new AbortController();
  const ps = createPluginScope(parentCtrl.signal, 'booster-test');
  expect(typeof ps.setTimeout).toBe('function');
  expect(typeof ps.setInterval).toBe('function');
  expect(typeof ps.clearTimeout).toBe('function');
  expect(typeof ps.clearInterval).toBe('function');
  expect(typeof ps.listen).toBe('function');
  expect(typeof ps.fetch).toBe('function');
  expect(typeof ps.abortable).toBe('function');
  expect(typeof ps.observer).toBe('function');
});
