import { test, expect } from 'bun:test';
import { crossValidate } from '../src/plugins/validation';
import { ContextKind, Capability, type PluginManifest } from '../src/api/api-types';

interface ManifestEntry {
  id: string;
  version: string;
  apiVersion: number;
  contextKinds: string[];
  urlPatterns?: string[];
  grantedCapabilities: string[];
}

const bundle: PluginManifest = {
  id: 'booster-test', version: '1.0.0', apiVersion: 1,
  displayName: 'Test', contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui], init: () => undefined,
};

const manifestEntry: ManifestEntry = {
  id: 'booster-test', version: '1.0.0', apiVersion: 1,
  contextKinds: ['main'], grantedCapabilities: ['ui'],
};

test('matching bundle and manifest passes', () => {
  expect(crossValidate(bundle, manifestEntry)).toEqual({ ok: true });
});

test('id mismatch fails', () => {
  const r = crossValidate(bundle, { ...manifestEntry, id: 'booster-other' });
  expect(r.ok).toBe(false);
  expect((r as { ok: false; reason: string }).reason).toMatch(/id mismatch/);
});

test('version mismatch fails', () => {
  const r = crossValidate(bundle, { ...manifestEntry, version: '2.0.0' });
  expect(r.ok).toBe(false);
  expect((r as { ok: false; reason: string }).reason).toMatch(/version mismatch/);
});

test('apiVersion mismatch fails', () => {
  const r = crossValidate(bundle, { ...manifestEntry, apiVersion: 2 });
  expect(r.ok).toBe(false);
  expect((r as { ok: false; reason: string }).reason).toMatch(/api version mismatch/);
});

test('bundle contextKinds subset of manifest passes', () => {
  // bundle declares [main], manifest grants [main, shared] — OK (bundle is stricter)
  const r = crossValidate(bundle, { ...manifestEntry, contextKinds: ['main', 'shared'] });
  expect(r.ok).toBe(true);
});

test('bundle contextKind not in manifest fails', () => {
  // bundle declares [shared], manifest grants only [main]
  const stricter: PluginManifest = { ...bundle, contextKinds: [ContextKind.Shared] };
  const r = crossValidate(stricter, manifestEntry);
  expect(r.ok).toBe(false);
  expect((r as { ok: false; reason: string }).reason).toMatch(/contextKind/);
});

test('bundle urlPatterns must be subset of manifest', () => {
  const withPatterns: PluginManifest = { ...bundle, urlPatterns: ['^.*$'] };
  const r = crossValidate(withPatterns, { ...manifestEntry, urlPatterns: ['^https://x'] });
  expect(r.ok).toBe(false);
  expect((r as { ok: false; reason: string }).reason).toMatch(/urlPattern/);
});

test('capabilities are NOT cross-checked (intersection computed elsewhere)', () => {
  const askMore: PluginManifest = { ...bundle, capabilities: [Capability.Ui, Capability.Bus] };
  // Manifest grants only ui; bundle wants ui+bus. This is valid (bus simply not granted).
  expect(crossValidate(askMore, manifestEntry)).toEqual({ ok: true });
});
