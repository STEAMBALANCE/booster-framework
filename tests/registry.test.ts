import { test, expect } from 'bun:test';
import { createRegistry } from '../src/registry';

test('registry pushes and rolls back in LIFO', () => {
  const reg = createRegistry();
  const calls: string[] = [];
  reg.push({ description: 'a', undo: () => calls.push('a') });
  reg.push({ description: 'b', undo: () => calls.push('b') });
  reg.rollbackAll();
  expect(calls).toEqual(['b', 'a']);
  expect(reg.size()).toBe(0);
});

test('registry continues rollback even if one undo throws', () => {
  const reg = createRegistry();
  const calls: string[] = [];
  reg.push({ description: 'a', undo: () => calls.push('a') });
  reg.push({ description: 'bad', undo: () => { throw new Error('boom'); } });
  reg.push({ description: 'c', undo: () => calls.push('c') });
  reg.rollbackAll();
  expect(calls).toEqual(['c', 'a']);
});

test('remove(id) removes specific entry', () => {
  const reg = createRegistry();
  const calls: string[] = [];
  const id1 = reg.push({ description: 'a', undo: () => calls.push('a') });
  reg.push({ description: 'b', undo: () => calls.push('b') });
  reg.remove(id1);
  reg.rollbackAll();
  expect(calls).toEqual(['b']);
});
