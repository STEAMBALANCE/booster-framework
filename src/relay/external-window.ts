import type {
  ExternalWindowOpenRequest,
  ExternalWindowOpenReply,
  ExternalWindowSetUrlRequest,
  ExternalWindowCloseRequest,
  ExternalWindowNativeTitleRequest,
  ExternalWindowStateEvent,
} from './protocol';
import type { Bridge } from '../bridge';
import { isTagged, RELAY_SECRET_FIELD } from './channel';
import { canonicalUrl, redactErr } from './url-helpers';

interface OurEntry {
  id: string;
  reqId: number;
  /** Title для inject-script. undefined → нет inject. */
  title?: string;
  /** Three-state controller signal — see computeEffectiveTaskbar. */
  effectiveTaskbar: string | null | undefined;
}

export function computeEffectiveTaskbar(
  title: string | undefined,
  taskbarTitle: string | null | undefined,
): string | null | undefined {
  if (taskbarTitle === null) return null;
  if (typeof taskbarTitle === 'string') return taskbarTitle;
  if (typeof title === 'string') return title;
  return undefined;
}

const ourEntries = new Map<string, OurEntry>();
let mwbmSubscriptionUnreg: (() => void) | null = null;
let bcChannel: { postMessage: (m: any) => void } | null = null;
let mwbmStore: any = null;  // injected from bootstrap (or test)
let bridge: Bridge | null = null;
// Per-launch relay secret. Replies to the TRUSTED main-shell consumer
// (external-window-open-reply / external-window-close-event) are tagged with
// it; inbound trusted kinds (open/set-url/close) require it. The OUTBOUND
// `external-window-state` is deliberately posted UNTAGGED (see broadcastState)
// because its consumer is the UNTRUSTED C++ tabbed-shell controller — tagging
// would leak the secret to co-resident web content. undefined ⇒ no auth.
let relaySecret: string | undefined = undefined;
// Suppresses MWBM callback during our own Add/Remove operations.
// Without this, AddWebPageRequest fires the callback synchronously,
// onMWBMChange broadcasts state before ourEntries is updated, and the
// first state message seen by tests has an empty ourRequestIds.
let suppressMwbmCallback = false;

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function _internal_setBcChannel(bc: { postMessage: (m: any) => void }): void { bcChannel = bc; }
export function _internal_setMwbmStore(s: any): void { mwbmStore = s; }
export function _internal_setBridge(b: Bridge | null): void { bridge = b; }
export function _internal_setSecret(s: string | undefined): void { relaySecret = s; }
export function _internal_getOurEntries(): Map<string, OurEntry> { return ourEntries; }
export function _internal_resetRelay(): void {
  ourEntries.clear();
  if (mwbmSubscriptionUnreg) try { mwbmSubscriptionUnreg(); } catch {}
  mwbmSubscriptionUnreg = null;
  bcChannel = null;
  mwbmStore = null;
  bridge = null;
  relaySecret = undefined;
  suppressMwbmCallback = false;
}

/** Tagged post for replies destined for the TRUSTED main-shell consumer
 *  (api/external-window.ts). NOT used for external-window-state. */
function postTagged(msg: object): void {
  bcChannel?.postMessage(relaySecret !== undefined ? { ...msg, [RELAY_SECRET_FIELD]: relaySecret } : msg);
}

function validateOpenMessage(m: ExternalWindowOpenRequest): string | null {
  if (typeof m !== 'object' || m === null) return 'invalid message shape';
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'invalid id';

  if (m.title !== undefined) {
    if (typeof m.title !== 'string' || m.title.length < 1 || m.title.length > 200) {
      return 'invalid title (1..200 chars or undefined)';
    }
  }

  if (m.taskbarTitle !== undefined && m.taskbarTitle !== null) {
    if (typeof m.taskbarTitle !== 'string' ||
        m.taskbarTitle.length < 1 || m.taskbarTitle.length > 200) {
      return 'invalid taskbarTitle (1..200 chars or null/undefined)';
    }
  }

  return validateUrlInternal(m.url, 'url');
}

function validateUrlInternal(url: unknown, label: string): string | null {
  if (typeof url !== 'string') return `${label}: must be a string`;
  if (url.length > 2048) return `${label}: too long`;
  if (!/^https:\/\//i.test(url)) return `${label}: only https:// allowed`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return `${label}: invalid URL`; }
  if (parsed.username || parsed.password) return `${label}: userinfo not allowed`;
  if (parsed.port) return `${label}: explicit port not allowed`;
  if (/[^\x20-\x7E]/.test(url)) return `${label}: non-ASCII not allowed`;
  return null;
}

function ensureSubscription(store: any): void {
  if (mwbmSubscriptionUnreg) return;
  mwbmSubscriptionUnreg = store.m_cbWebPageRequestsChanged.Register(() => onMWBMChange(store));
}

function onMWBMChange(store: any): void {
  if (suppressMwbmCallback) return;
  const currentReqIds = new Set<number>((store.m_rgWebPageRequests || []).map((r: any) => r.requestid));
  const closedIds: string[] = [];
  for (const [id, entry] of ourEntries) {
    // Skip placeholder entries (reqId=0) — they are mid-async-open.
    if (entry.reqId === 0) continue;
    if (!currentReqIds.has(entry.reqId)) closedIds.push(id);
  }
  for (const id of closedIds) {
    ourEntries.delete(id);
    postTagged({ kind: 'external-window-close-event', id });
  }
  broadcastState(store);
}

function broadcastState(store: any): void {
  const requests: Array<{ requestid: number; strURL: string }> = store.m_rgWebPageRequests || [];
  const activeId = store.m_nActiveWebpageRequestID;
  let activeIsOurs = false;
  let activeOurId: string | null = null;
  let activeTitle: string | null | undefined = undefined;

  for (const e of ourEntries.values()) {
    if (e.reqId === 0) continue;  // skip placeholders
    if (e.reqId === activeId) {
      activeIsOurs = true;
      activeOurId = e.id;
      activeTitle = e.effectiveTaskbar;
      break;
    }
  }

  const event: ExternalWindowStateEvent = {
    kind: 'external-window-state',
    shellRequestIds: requests.map(r => r.requestid),
    ourRequestIds: Array.from(ourEntries.values())
      .filter(e => e.reqId !== 0)
      .map(e => ({
        id: e.id, reqId: e.reqId,
        ...(e.effectiveTaskbar !== undefined ? { title: e.effectiveTaskbar } : {}),
      })),
    activeRequestId: activeId,
    activeIsOurs, activeOurId,
    ...(activeTitle !== undefined ? { activeTitle } : {}),
    manifestHints: getManifestTabbedShellHints(),
  };
  // UNTAGGED on purpose: external-window-state is consumed by the untrusted
  // C++ tabbed-shell controller (co-resident with web content). Tagging would
  // leak the per-launch secret. See relaySecret comment above.
  bcChannel?.postMessage(event);
}

function getManifestTabbedShellHints(): string[] {
  try {
    const cfg = (globalThis as { __SB_PLUGINS_MANIFEST__?: { tabbedShellHints?: unknown } }).__SB_PLUGINS_MANIFEST__;
    if (!cfg || !Array.isArray(cfg.tabbedShellHints)) return [];
    return cfg.tabbedShellHints.filter((s: unknown): s is string =>
      typeof s === 'string' && s.length > 0 && s.length < 200);
  } catch { return []; }
}

function replyOpen(requestId: number, payload: { ok: true } | { ok: false; error: string }): void {
  const reply: ExternalWindowOpenReply = { kind: 'external-window-open-reply', requestId, ...payload };
  postTagged(reply);
}

export async function handleOpen(msg: ExternalWindowOpenRequest): Promise<void> {
  const error = validateOpenMessage(msg);
  if (error) return replyOpen(msg.requestId, { ok: false, error });
  if (ourEntries.has(msg.id)) {
    return replyOpen(msg.requestId, { ok: false, error: `id '${msg.id}' already in use` });
  }
  if (!mwbmStore || typeof mwbmStore.AddWebPageRequest !== 'function') {
    return replyOpen(msg.requestId, { ok: false, error: 'MWBM not available' });
  }

  // Reserve id BEFORE any await — sentinel reqId=0 distinguishes from
  // real entries (Steam reqIds start at 1).
  ourEntries.set(msg.id, { id: msg.id, reqId: 0, title: undefined, effectiveTaskbar: undefined });

  let url: string;
  try {
    url = canonicalUrl(msg.url);
  } catch {
    ourEntries.delete(msg.id);
    return replyOpen(msg.requestId, { ok: false, error: 'invalid url' });
  }

  ensureSubscription(mwbmStore);

  let priorTargetIds: string[] = [];
  if (msg.title && bridge) {
    try {
      const r = await bridge.call('listPageTargetIds', {}) as { targetIds?: unknown };
      const ids = r?.targetIds;
      priorTargetIds = Array.isArray(ids)
        ? ids.filter((s): s is string => typeof s === 'string')
        : [];
    } catch (e) {
      console.error('[booster-relay] listPageTargetIds failed:', redactErr(e));
    }
  }

  if (!ourEntries.has(msg.id)) return;  // teardown raced

  const before = new Set<number>(
    (mwbmStore.m_rgWebPageRequests || []).map((r: any) => r.requestid));
  suppressMwbmCallback = true;
  try {
    mwbmStore.AddWebPageRequest(url, true);
  } finally {
    suppressMwbmCallback = false;
  }
  const after = (mwbmStore.m_rgWebPageRequests || []) as Array<{
    requestid: number; strURL: string;
  }>;
  const ours = after.find(r => !before.has(r.requestid) && r.strURL === url);
  if (!ours) {
    ourEntries.delete(msg.id);
    return replyOpen(msg.requestId, {
      ok: false, error: 'AddWebPageRequest did not surface our request',
    });
  }

  const effectiveTaskbar = computeEffectiveTaskbar(msg.title, msg.taskbarTitle);
  ourEntries.set(msg.id, {
    id: msg.id, reqId: ours.requestid,
    title: msg.title, effectiveTaskbar,
  });

  replyOpen(msg.requestId, { ok: true });
  broadcastState(mwbmStore);

  if (msg.title && bridge) {
    void requestTitleOverride(url, msg.title, priorTargetIds);
  }
}

async function requestTitleOverride(
  url: string, title: string, priorTargetIds: string[],
): Promise<void> {
  if (!bridge) return;
  try {
    await bridge.call('injectTabTitleOverride', { url, title, priorTargetIds });
  } catch (e) {
    console.error('[booster-relay] injectTabTitleOverride failed:', redactErr(e));
  }
}

export async function handleSetUrl(msg: ExternalWindowSetUrlRequest): Promise<void> {
  const error = validateUrlInternal(msg.url, 'setUrl');
  if (error) {
    console.error('[booster-relay] external-window-set-url:', error);
    return;
  }
  let entry = ourEntries.get(msg.id);
  if (!entry) return;
  if (!mwbmStore) return;

  let url: string;
  try { url = canonicalUrl(msg.url); }
  catch { return; }

  let priorTargetIds: string[] = [];
  if (entry.title && bridge) {
    try {
      const r = await bridge.call('listPageTargetIds', {}) as { targetIds?: unknown };
      const ids = r?.targetIds;
      priorTargetIds = Array.isArray(ids)
        ? ids.filter((s): s is string => typeof s === 'string')
        : [];
    } catch (e) {
      console.error('[booster-relay] listPageTargetIds (setUrl) failed:', redactErr(e));
    }
  }

  // Re-check entry and store survival after the await — close-event or
  // teardown may have fired while we awaited listPageTargetIds.
  entry = ourEntries.get(msg.id);
  if (!entry || entry.reqId === 0) return;
  if (!mwbmStore) return;

  const oldReqId = entry.reqId;
  const before = new Set<number>((mwbmStore.m_rgWebPageRequests || []).map((r: any) => r.requestid));
  suppressMwbmCallback = true;
  try {
    mwbmStore.AddWebPageRequest(url, true);
  } finally {
    suppressMwbmCallback = false;
  }
  const after = (mwbmStore.m_rgWebPageRequests || []) as Array<{ requestid: number; strURL: string }>;
  const ours = after.find(r => !before.has(r.requestid) && r.strURL === url);
  if (!ours) {
    console.error('[booster-relay] setUrl: new request not surfaced');
    ourEntries.delete(msg.id);
    postTagged({ kind: 'external-window-close-event', id: msg.id });
    return;
  }
  entry.reqId = ours.requestid;  // CRITICAL: before Remove (entry re-fetched above; mutates live map object)
  try {
    suppressMwbmCallback = true;
    mwbmStore.RemoveWebPageRequest(oldReqId);
  } catch (e) {
    console.error('[booster-relay] RemoveWebPageRequest threw:', e);
  } finally {
    suppressMwbmCallback = false;
  }
  broadcastState(mwbmStore);

  if (entry.title && bridge) {
    void requestTitleOverride(url, entry.title, priorTargetIds);
  }
}

export function handleClose(msg: ExternalWindowCloseRequest): void {
  const entry = ourEntries.get(msg.id);
  if (!entry) return;
  if (!mwbmStore) return;
  try {
    mwbmStore.RemoveWebPageRequest(entry.reqId);
  } catch (e) {
    console.error('[booster-relay] RemoveWebPageRequest on close:', e);
  }
}

export function handleStateRequest(): void {
  if (!mwbmStore || !bcChannel) return;
  broadcastState(mwbmStore);
}

export async function handleNativeTitleRequest(msg: ExternalWindowNativeTitleRequest): Promise<void> {
  if (typeof msg.title !== 'string' || msg.title.length === 0 || msg.title.length > 200) {
    console.error('[booster-relay] native-title: invalid title');
    return;
  }
  const g = msg.geometry;
  if (!g || g.w <= 0 || g.h <= 0) {
    console.error('[booster-relay] native-title: invalid geometry');
    return;
  }
  if (!bridge) {
    console.error('[booster-relay] native-title: no bridge');
    return;
  }
  try {
    await bridge.call('setNativeWindowTitle', { title: msg.title, geometry: g });
  } catch (e) {
    console.error('[booster-relay] native-title bridge call failed:', e);
  }
}

export interface ExternalWindowRelayDeps {
  bcChannel: { postMessage: (m: any) => void; addEventListener: (t: string, cb: any) => void };
  mwbmStore: any;
  bridge: Bridge;
  /** Per-launch relay secret. undefined ⇒ no auth (tests / pre-secret injector). */
  relaySecret?: string;
}

// The two kinds the UNTRUSTED C++ tabbed-shell controller posts. Accepted
// UNTAGGED (the controller has no secret) but still structurally validated in
// their handlers. Everything else (open/set-url/close) is TRUSTED main-shell
// traffic and requires the tag.
const CARVE_OUT_KINDS = new Set([
  'external-window-native-title-request',
  'external-window-state-request',
]);

export function setupExternalWindowRelay(deps: ExternalWindowRelayDeps): void {
  bcChannel = deps.bcChannel;
  mwbmStore = deps.mwbmStore;
  bridge = deps.bridge;
  relaySecret = deps.relaySecret;
  ensureSubscription(mwbmStore);

  deps.bcChannel.addEventListener('message', (e: { data: unknown }) => {
    const m = e.data as any;
    if (!m || typeof m !== 'object') return;
    // Auth: trusted kinds require the tag; carve-out kinds are accepted
    // untagged (untrusted tabbed-shell origin) and validated structurally.
    if (!CARVE_OUT_KINDS.has(m.kind) && !isTagged(m, relaySecret)) return;
    switch (m.kind) {
      case 'external-window-open': void handleOpen(m).catch(e => console.error('[booster-relay] handleOpen threw:', e)); break;
      case 'external-window-set-url': void handleSetUrl(m).catch(e => console.error('[booster-relay] handleSetUrl threw:', e)); break;
      case 'external-window-close': handleClose(m); break;
      case 'external-window-native-title-request': void handleNativeTitleRequest(m); break;
      case 'external-window-state-request': handleStateRequest(); break;
      default: return;
    }
  });
}

export function teardownExternalWindowRelay(): void {
  if (mwbmSubscriptionUnreg) {
    try { mwbmSubscriptionUnreg(); } catch {}
    mwbmSubscriptionUnreg = null;
  }
  ourEntries.clear();
  bcChannel = null;
  mwbmStore = null;
  bridge = null;
  relaySecret = undefined;
}
