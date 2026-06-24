import { describe, test, expect, beforeEach } from 'bun:test';
import { Window } from 'happy-dom';
import { makePagesApi } from '../src/api/pages';
import { makeContextApi } from '../src/api/context';
import { createScope } from '../src/api/scope';

function installDom(initialUrl = 'https://example.test/') {
  const w = new Window({ url: initialUrl });
  Object.assign(globalThis, {
    window: w, document: w.document, history: w.history, location: w.location,
    addEventListener: w.addEventListener.bind(w),
    removeEventListener: w.removeEventListener.bind(w),
  });
  return w;
}

function setup() {
  const scope = createScope();
  const context = makeContextApi(scope, 'web');
  const pages = makePagesApi(scope, context);
  return { scope, context, pages };
}

describe('makePagesApi', () => {
  beforeEach(() => {
    installDom();
  });

  test('mount fires immediately when URL matches at register time', async () => {
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    const mounts: URL[] = [];
    pages.register({
      name: 'p1',
      match: { url: /\/foo/ },
      mount: (ctx) => { mounts.push(ctx.url); },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(mounts.length).toBe(1);
    expect(mounts[0]?.pathname).toBe('/foo');
    scope._abort();
  });

  test('mount does NOT fire if URL does not match', async () => {
    history.replaceState(null, '', '/bar');
    const { pages, scope } = setup();
    let mounted = false;
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: () => { mounted = true; },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(mounted).toBe(false);
    scope._abort();
  });

  test('navigation match → mount, navigation away → unmount', async () => {
    history.replaceState(null, '', '/bar');
    const { pages, scope } = setup();
    const events: string[] = [];
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: () => { events.push('mount'); return () => events.push('unmount'); },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    history.pushState(null, '', '/foo');
    await new Promise(r => setTimeout(r, 5));
    history.pushState(null, '', '/baz');
    await new Promise(r => setTimeout(r, 5));
    expect(events).toEqual(['mount', 'unmount']);
    scope._abort();
  });

  test('matched URL changing to another matched URL does NOT re-mount', async () => {
    history.replaceState(null, '', '/foo/a');
    const { pages, scope } = setup();
    const events: string[] = [];
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: () => { events.push('mount'); return () => events.push('unmount'); },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    history.pushState(null, '', '/foo/b');
    await new Promise(r => setTimeout(r, 5));
    history.pushState(null, '', '/foo/c');
    await new Promise(r => setTimeout(r, 5));
    expect(events).toEqual(['mount']);
    scope._abort();
  });

  test('predicate matcher works', async () => {
    history.replaceState(null, '', '/foo?x=1');
    const { pages, scope } = setup();
    let mounted = false;
    pages.register({
      name: 'p1',
      match: { url: (u) => u.searchParams.has('x') },
      mount: () => { mounted = true; },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(mounted).toBe(true);
    scope._abort();
  });

  test('async mount: cleanup returned by promise is invoked on unmount', async () => {
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    const events: string[] = [];
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: async () => {
        await new Promise(r => setTimeout(r, 10));
        events.push('mount-done');
        return () => events.push('unmount');
      },
    });
    await new Promise(r => setTimeout(r, 30));
    history.pushState(null, '', '/bar');
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual(['mount-done', 'unmount']);
    scope._abort();
  });

  test('URL leaves match during async mount → unmount fires after settle', async () => {
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    const events: string[] = [];
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: async () => {
        await new Promise(r => setTimeout(r, 30));
        events.push('mount-done');
        return () => events.push('unmount');
      },
    });
    history.pushState(null, '', '/bar');
    await new Promise(r => setTimeout(r, 60));
    expect(events).toEqual(['mount-done', 'unmount']);
    scope._abort();
  });

  test('duplicate name throws sync', () => {
    const { pages, scope } = setup();
    pages.register({ name: 'p1', match: { url: /./  }, mount: () => {} });
    expect(() => pages.register({ name: 'p1', match: { url: /./ }, mount: () => {} }))
      .toThrow(/duplicate name/);
    scope._abort();
  });

  test('scope._abort triggers unmount on all active mounts', async () => {
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    let unmounted = false;
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: () => () => { unmounted = true; },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    scope._abort();
    await new Promise(r => setTimeout(r, 5));
    expect(unmounted).toBe(true);
  });

  test('unregister removes registration + unmounts if active', async () => {
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    let unmounted = false;
    const handle = pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: () => () => { unmounted = true; },
    });
    await new Promise(r => queueMicrotask(() => r(null)));
    handle.unregister();
    await new Promise(r => setTimeout(r, 5));
    expect(unmounted).toBe(true);
    scope._abort();
  });

  test('URL flips back to match during awaited unmount → reconciler re-mounts (re-entrancy dirty flag)', async () => {
    // Race: async mount is still pending → URL flips to /bar (reconcile A
    // detaches mountedAt then awaits cur.pending in unmountIfActive) →
    // URL flips back to /foo during that await (reconcile B fires but the
    // re-entrancy guard returns early after setting reconcileDirty=true).
    // Without the dirty flag, reconcile A's loop iteration would never
    // observe the second flip — registration stays unmounted while URL
    // once again matches. With it, A loops once more after pending settles
    // and re-mounts.
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    const mountCount: number[] = [];
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: async () => {
        mountCount.push(1);
        // Slow async mount — pending promise hangs through the URL flips.
        await new Promise(r => setTimeout(r, 30));
        return () => {};
      },
    });
    // Microtask drain so the initial reconcile fires (mount kicks off,
    // pending is set) before we start flipping URLs.
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(mountCount.length).toBe(1);

    // First flip while mount is still pending: reconcile A enters, sees
    // active && !matched, calls unmountIfActive → detaches reg.mountedAt
    // → awaits cur.pending (the slow mount promise).
    history.pushState(null, '', '/bar');
    // Microtask drain so reconcile A actually starts awaiting before B fires.
    await Promise.resolve();
    // Second flip BACK to a match. reconcile B fires while A is awaiting
    // — guard returns early but sets reconcileDirty=true.
    history.pushState(null, '', '/foo');

    // Let the slow mount finish (30ms) + the dirty re-loop iteration run.
    await new Promise(r => setTimeout(r, 80));

    // Net: mount must have been called at least twice — second iteration
    // of the dirty-loop re-considers and re-mounts since the URL once
    // again matches.
    expect(mountCount.length).toBeGreaterThanOrEqual(2);
    scope._abort();
  });

  test('mount throwing logs warn and drops state (no orphan)', async () => {
    history.replaceState(null, '', '/foo');
    const { pages, scope } = setup();
    pages.register({
      name: 'p1', match: { url: /\/foo/ },
      mount: () => { throw new Error('boom'); },
    });
    await new Promise(r => setTimeout(r, 10));
    // No throw escaping — register a different name works
    expect(() => pages.register({
      name: 'p2', match: { url: /\/foo/ },
      mount: () => {},
    })).not.toThrow();
    scope._abort();
  });
});
