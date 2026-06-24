import { test, expect } from 'bun:test';
import { ContextKind } from '../src/api/api-types';

test('ContextKind has the four expected values', () => {
  expect(ContextKind.Main).toBe('main');
  expect(ContextKind.Shared).toBe('shared');
  expect(ContextKind.TabbedBrowser).toBe('tabbedBrowser');
  expect(ContextKind.Web).toBe('web');
});

test('ContextKind is exhaustively typed', () => {
  const all = Object.values(ContextKind);
  expect(all).toHaveLength(4);
  expect(all).toContain('main');
  expect(all).toContain('shared');
  expect(all).toContain('tabbedBrowser');
  expect(all).toContain('web');
});
