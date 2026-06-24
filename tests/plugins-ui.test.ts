import { test, expect } from 'bun:test';
import { createPluginUi } from '../src/plugins/ui';
import type { UiApi, HeaderButtonOptions, AttachedPopupOptions, OpenWindowOptions, OpenExternalWindowOptions } from '../src/api/api-types';

interface CapturedCalls {
  headerButton?: HeaderButtonOptions;
  popup?: AttachedPopupOptions;
  window?: OpenWindowOptions;
  externalWindow?: OpenExternalWindowOptions;
}

function makeMockUi(captured: CapturedCalls): UiApi {
  return {
    addHeaderButton: (o) => { captured.headerButton = o; return { remove: () => {}, setLabel: () => {}, setEnabled: () => {}, getRect: () => new DOMRect() } as never; },
    attachPopup: async (o) => { captured.popup = o; return {} as never; },
    openWindow: async (o) => { captured.window = o; return {} as never; },
    openExternalWindow: async (o) => { captured.externalWindow = o; return {} as never; },
  };
}

test('addHeaderButton auto-prefixes id with pluginId__', () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  wrapped.addHeaderButton({ id: 'sb_topup', label: 'Топап', onClick: () => {} }); // strings-allow-cyrillic
  expect(captured.headerButton?.id).toBe('booster-checkout__sb_topup');
});

test('attachPopup auto-prefixes id', async () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  await wrapped.attachPopup({ id: 'my-popup', width: 300, anchorId: 'booster-checkout__sb_topup' } as AttachedPopupOptions);
  expect(captured.popup?.id).toBe('booster-checkout__my-popup');
});

test('openWindow auto-prefixes id', async () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  await wrapped.openWindow({ id: 'win1', width: 800, height: 600, title: 'X' } as OpenWindowOptions);
  expect(captured.window?.id).toBe('booster-checkout__win1');
});

test('openExternalWindow auto-prefixes id', async () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  await wrapped.openExternalWindow({ id: 'ext1', url: 'about:blank' } as OpenExternalWindowOptions);
  expect(captured.externalWindow?.id).toBe('booster-checkout__ext1');
});

test('invalid user id is rejected (path-traversal characters)', () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  expect(() => wrapped.addHeaderButton({ id: '../escape', label: 'x', onClick: () => {} }))
    .toThrow(/invalid id/);
});

test('invalid user id is rejected (empty string)', () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  expect(() => wrapped.addHeaderButton({ id: '', label: 'x', onClick: () => {} }))
    .toThrow(/invalid id/);
});

test('valid user id with allowed chars (alphanumeric, _, -) accepted', () => {
  const captured: CapturedCalls = {};
  const wrapped = createPluginUi(makeMockUi(captured), 'booster-checkout');
  expect(() => wrapped.addHeaderButton({ id: 'a-b_c_123', label: 'x', onClick: () => {} }))
    .not.toThrow();
  expect(captured.headerButton?.id).toBe('booster-checkout__a-b_c_123');
});
