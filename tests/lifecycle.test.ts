import { test, expect } from 'bun:test';
import { makeLifecycleApi } from '../src/api/lifecycle';
import { createRegistry } from '../src/registry';
import { createScope } from '../src/api/scope';

test('lifecycle.ready resolves once _markReady is called', async () => {
  const scope = createScope();
  const registry = createRegistry();
  const lifecycle = makeLifecycleApi(registry, scope);
  let resolved = false;
  lifecycle.ready().then(() => { resolved = true; });
  // ready hasn't been marked yet — promise is pending
  await Promise.resolve();
  expect(resolved).toBe(false);
  lifecycle._markReady();
  await Promise.resolve();
  expect(resolved).toBe(true);
});

test('rollbackAll aborts scope BEFORE running registry undos', () => {
  // Ordering invariant: scope abort must complete before any registry
  // undo runs. A registry undo that triggers a click handler (or any
  // listener) must see the scope already aborted, so the listener is
  // already detached and can't recreate the DOM the undo is removing.
  const scope = createScope();
  const registry = createRegistry();
  const lifecycle = makeLifecycleApi(registry, scope);
  let undoRan = false;
  let signalAbortedAtUndo = false;
  registry.push({
    description: 'capture-signal',
    undo: () => {
      undoRan = true;
      signalAbortedAtUndo = scope.signal.aborted;
    },
  });
  lifecycle.rollbackAll();
  expect(undoRan).toBe(true);
  expect(signalAbortedAtUndo).toBe(true);
});

test('rollbackAll runs registry undos even if scope._abort throws', () => {
  // Defensive contract: if a future scope implementation adds side effects
  // that can throw inside _abort, the DOM-cleanup path must still run.
  // makeLifecycleApi wraps scope._abort in try/catch — this test guards it.
  //
  // We build a scope-like object via spread + override (instead of mutating
  // the original scope's _abort field) so a future hardening pass marking
  // ScopeApi members `readonly` won't break this test.
  const realScope = createScope();
  const throwingScope: typeof realScope = {
    ...realScope,
    _abort: () => { throw new Error('boom'); },
  };
  const registry = createRegistry();
  const lifecycle = makeLifecycleApi(registry, throwingScope);
  let undoCalls = 0;
  registry.push({ description: 'x', undo: () => { undoCalls++; } });
  expect(() => lifecycle.rollbackAll()).not.toThrow();
  expect(undoCalls).toBe(1);
});

test('rollbackAll is idempotent under already-aborted scope', () => {
  // Defensive: graceful exit (C++ Rollback) eval'ту __sb_relay_teardown
  // *and* sb.lifecycle.rollbackAll. The teardown path may have already
  // aborted the scope (through different code paths in different contexts).
  // Calling lifecycle.rollbackAll afterwards must still complete cleanly.
  const scope = createScope();
  scope._abort();
  const registry = createRegistry();
  const lifecycle = makeLifecycleApi(registry, scope);
  let undoCalls = 0;
  registry.push({ description: 'x', undo: () => { undoCalls++; } });
  expect(() => lifecycle.rollbackAll()).not.toThrow();
  expect(undoCalls).toBe(1);
});
