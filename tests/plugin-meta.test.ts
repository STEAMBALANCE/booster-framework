import { test, expect } from 'bun:test';
import { validatePluginMeta } from '../src/testing/plugin-meta';

const BASE = {
  id: 'food', version: '0.1.0', apiVersion: 1,
  contextKinds: ['main'], urlPatterns: [],
  grantedCapabilities: ['ui'],
};

test('accepts complete entry', () => {
  expect(validatePluginMeta(BASE).ok).toBe(true);
});

test('rejects missing id', () => {
  const { id, ...rest } = BASE;
  const r = validatePluginMeta(rest);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/id/);
});

test('rejects unknown capability', () => {
  const r = validatePluginMeta({ ...BASE, grantedCapabilities: ['ui', 'mindcontrol'] });
  expect(r.ok).toBe(false);
});

test('rejects unknown contextKind', () => {
  const r = validatePluginMeta({ ...BASE, contextKinds: ['main', 'gpu'] });
  expect(r.ok).toBe(false);
});

test('rejects bad semver', () => {
  const r = validatePluginMeta({ ...BASE, version: 'banana' });
  expect(r.ok).toBe(false);
});

test('rejects bad id regex', () => {
  const r = validatePluginMeta({ ...BASE, id: '0-bad-start' });
  expect(r.ok).toBe(false);
});
