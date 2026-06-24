import { test, expect } from 'bun:test';
import { WINDOW_MESSAGE_MAX_BYTES, SB_EMBED_V } from '../src/relay/protocol';

test('protocol embed constants', () => {
  expect(WINDOW_MESSAGE_MAX_BYTES).toBe(16 * 1024);
  expect(SB_EMBED_V).toBe(1);
});
