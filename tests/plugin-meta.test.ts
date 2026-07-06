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

test('accepts valid subscribeTopics', () => {
  const r = validatePluginMeta({ ...BASE, subscribeTopics: ['checkout.state', 'addfunds.*'] });
  expect(r.ok).toBe(true);
});

test('rejects malformed subscribeTopics entry', () => {
  const r = validatePluginMeta({ ...BASE, subscribeTopics: ['INVALID_TOPIC'] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/subscribeTopics\[0\]/);
});

test('rejects subscribeTopics entry with space', () => {
  const r = validatePluginMeta({ ...BASE, subscribeTopics: ['has space'] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/invalid topic format/);
});

const NET_BASE = {
  id: 'booster-x', version: '1.0.0', apiVersion: 1,
  contextKinds: ['web'] as const, urlPatterns: [], grantedCapabilities: ['net'] as const,
};

test('accepts valid allowedHosts', () => {
  const r = validatePluginMeta({ ...NET_BASE, allowedHosts: ['steambalance.cc'] });
  expect(r.ok).toBe(true);
});
test('accepts omitted allowedHosts', () => {
  const r = validatePluginMeta({ ...NET_BASE, allowedHosts: undefined });
  expect(r.ok).toBe(true);
});
test('rejects allowedHosts with scheme', () => {
  const r = validatePluginMeta({ ...NET_BASE, allowedHosts: ['https://steambalance.cc'] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/allowedHosts\[0\]/);
});
test('rejects allowedHosts with port or path or uppercase', () => {
  for (const bad of ['steambalance.cc:443', 'steambalance.cc/x', 'STEAMBALANCE.cc', 'a@b.cc', '*.steambalance.cc']) {
    const r = validatePluginMeta({ ...NET_BASE, allowedHosts: [bad] });
    expect(r.ok).toBe(false);
  }
});
test('grantedCapabilities accepts "net"', () => {
  const r = validatePluginMeta({ ...NET_BASE, grantedCapabilities: ['net'] });
  expect(r.ok).toBe(true);
});
