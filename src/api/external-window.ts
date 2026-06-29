import type { OpenExternalWindowHandle, OpenExternalWindowOptions } from './api-types';
import { isTagged, stripTag, RELAY_SECRET_FIELD } from '../relay/channel';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

interface BcLike {
  postMessage: (m: any) => void;
  addEventListener: (t: string, cb: (e: { data: unknown }) => void) => void;
  removeEventListener?: (t: string, cb: (e: { data: unknown }) => void) => void;
}

/** Wraps a raw sb_cmd channel so all outbound external-window messages carry
 *  the per-launch secret and inbound replies/events lacking it are dropped.
 *  `secret === undefined` ⇒ passthrough (tests / pre-secret injector). */
function makeAuthChannel(bc: BcLike, secret: string | undefined): BcLike {
  if (secret === undefined) return bc;
  const wrappers = new WeakMap<(e: { data: unknown }) => void, (e: { data: unknown }) => void>();
  return {
    postMessage: (m: any) => bc.postMessage({ ...m, [RELAY_SECRET_FIELD]: secret }),
    addEventListener: (t, cb) => {
      const wrapped = (e: { data: unknown }) => {
        if (!isTagged(e.data, secret)) return;
        cb({ data: stripTag(e.data as object) });
      };
      wrappers.set(cb, wrapped);
      bc.addEventListener(t, wrapped);
    },
    removeEventListener: (t, cb) => {
      const wrapped = wrappers.get(cb);
      if (wrapped) bc.removeEventListener?.(t, wrapped);
    },
  };
}
const TITLE_MIN = 1;
const TITLE_MAX = 200;

// Counter-correlation для request/reply через BC. Pattern идентичен
// framework/src/api/ui.ts:25-78. Module-level state — на одну
// framework-instance ровно один createExternalWindowApi() call.
let nextRequestId = 1;
const REQUEST_ID_MAX = 0x7fffffff;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const REQUEST_TIMEOUT_MS = 5000;

export function _internal_resetForTest(): void {
  nextRequestId = 1;
  pending.clear();
}

export function _internal_bcRequest(
  bc: { postMessage: (m: any) => void },
  msg: { kind: string; [k: string]: unknown },
  timeoutMsOverride?: number,  // injectable for tests; default REQUEST_TIMEOUT_MS
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (nextRequestId >= REQUEST_ID_MAX) {
      reject(new Error('external-window: requestId space exhausted'));
      return;
    }
    const requestId = nextRequestId++;
    const timeoutMs = timeoutMsOverride ?? REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`external-window: BC timeout for ${msg.kind} after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(requestId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    bc.postMessage({ ...msg, requestId });
  });
}

export function _internal_installReplyRouter(
  bc: { addEventListener: (t: string, cb: (e: { data: unknown }) => void) => void },
): void {
  bc.addEventListener('message', (e) => {
    const m = e.data as { kind?: string; requestId?: number; ok?: boolean; error?: string } | undefined;
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'external-window-open-reply' && typeof m.requestId === 'number') {
      const p = pending.get(m.requestId);
      if (!p) return;
      pending.delete(m.requestId);
      p.resolve(m);
    }
  });
}

export function validateOpts(opts: OpenExternalWindowOptions): void {
  if (typeof opts !== 'object' || opts === null) {
    throw new Error('openExternalWindow: opts must be an object');
  }
  if (typeof opts.id !== 'string' || !ID_RE.test(opts.id)) {
    throw new Error(`openExternalWindow: id must match ${ID_RE}`);
  }
  validateUrl(opts.url, 'opts.url');

  if (opts.title !== undefined) {
    if (typeof opts.title !== 'string' ||
        opts.title.length < TITLE_MIN ||
        opts.title.length > TITLE_MAX) {
      throw new Error(
        `openExternalWindow: title must be a string ${TITLE_MIN}..${TITLE_MAX} chars`);
    }
  }

  if (opts.taskbarTitle !== undefined && opts.taskbarTitle !== null) {
    if (typeof opts.taskbarTitle !== 'string' ||
        opts.taskbarTitle.length < TITLE_MIN ||
        opts.taskbarTitle.length > TITLE_MAX) {
      throw new Error(
        `openExternalWindow: taskbarTitle must be a string ${TITLE_MIN}..${TITLE_MAX} chars or null`);
    }
  }
}

export function validateUrl(url: string, label: string): void {
  if (typeof url !== 'string') throw new Error(`${label}: must be a string`);
  if (url.length > 2048) throw new Error(`${label}: too long`);
  if (!/^https:\/\//.test(url)) throw new Error(`${label}: only https:// allowed`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${label}: invalid URL`); }
  if (parsed.username || parsed.password) throw new Error(`${label}: userinfo not allowed`);
  if (parsed.port) throw new Error(`${label}: explicit port not allowed`);
  if (/[^\x20-\x7E]/.test(url)) throw new Error(`${label}: non-ASCII characters not allowed`);
}

export interface ExternalWindowApiDeps {
  bcChannel: BroadcastChannel | { postMessage: (m: any) => void; addEventListener: (t: string, cb: any) => void };
  /** Per-launch relay secret (from `_sec.relaySecret`). Tags outbound and
   *  filters inbound. Omitted ⇒ untagged passthrough. */
  relaySecret?: string;
}

export function createExternalWindowApi(deps: ExternalWindowApiDeps) {
  const ch = makeAuthChannel(deps.bcChannel as BcLike, deps.relaySecret);
  _internal_installReplyRouter(ch as any);

  return {
    async openExternalWindow(opts: OpenExternalWindowOptions): Promise<OpenExternalWindowHandle> {
      validateOpts(opts);
      const reply = await _internal_bcRequest(ch as any, {
        kind: 'external-window-open',
        id: opts.id,
        url: opts.url,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.taskbarTitle !== undefined ? { taskbarTitle: opts.taskbarTitle } : {}),
      });
      if (!reply.ok) throw new Error(`openExternalWindow: ${reply.error ?? 'unknown error'}`);
      return makeHandle(opts.id, ch as any);
    },
  };
}

function makeHandle(id: string, bc: any): OpenExternalWindowHandle {
  let closed = false;
  const closeCallbacks: Array<() => void> = [];

  let fireClose: () => void;

  const listener = (e: { data: unknown }) => {
    const m = e.data as { kind?: string; id?: string } | undefined;
    if (!m || m.kind !== 'external-window-close-event' || m.id !== id) return;
    fireClose();
  };
  bc.addEventListener('message', listener);

  fireClose = () => {
    if (closed) return;
    closed = true;
    try { bc.removeEventListener('message', listener); } catch {}
    const cbs = closeCallbacks.splice(0);
    for (const cb of cbs) {
      try { cb(); } catch (e) { console.error('[booster-external-window] close cb threw:', e); }
    }
  };

  return {
    get id() { return id; },
    setUrl(url: string) {
      if (closed) return;
      validateUrl(url, 'setUrl(url)');
      bc.postMessage({ kind: 'external-window-set-url', id, url });
    },
    close() {
      if (closed) return;
      bc.postMessage({ kind: 'external-window-close', id });
    },
    on(event: 'close', cb: () => void): () => void {
      if (event !== 'close') throw new Error(`unknown event: ${event}`);
      if (closed) {
        queueMicrotask(() => { try { cb(); } catch {} });
        return () => {};
      }
      closeCallbacks.push(cb);
      return () => {
        const i = closeCallbacks.indexOf(cb);
        if (i >= 0) closeCallbacks.splice(i, 1);
      };
    },
  };
}
