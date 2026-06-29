import { RELAY_CHANNEL } from './protocol';

// Capture at module load so a plugin reassigning globalThis.BroadcastChannel
// cannot redirect relay channel construction.
const _BroadcastChannel = BroadcastChannel;

/** Envelope field that carries the per-launch secret tag on every relay message. */
export const RELAY_SECRET_FIELD = '__sbsec';

/** Minimal poster surface — anything that can emit a relay message. Used to
 *  thread a *tagging* post function into relay sub-handlers that only ever
 *  post (never listen) without coupling them to the full BroadcastChannel. */
export interface RelayPoster {
  postMessage(message: unknown): void;
}

/** Authenticated wrapper around BroadcastChannel('sb_cmd').
 *  `post` tags outbound messages; `onMessage` drops inbound messages that
 *  lack the matching tag and strips the tag before delivering to the callback.
 *  When `secret` is undefined no tagging or filtering is applied (back-compat /
 *  untrusted-wrapper carve-out). */
export interface RelayChannel {
  post(msg: object): void;
  /** Post WITHOUT the secret tag, regardless of configured secret. For the
   *  untrusted-tabbed-shell carve-out (external-window-state) where tagging
   *  would leak the secret to co-resident web content. */
  postUntagged(msg: object): void;
  onMessage(cb: (data: unknown) => void): () => void;
  raw: BroadcastChannel;
  close(): void;
}

/** Returns true iff `data` carries the matching secret tag (or no secret is
 *  configured). `undefined` secret ⇒ accept everything (back-compat). */
export function isTagged(data: unknown, secret: string | undefined): boolean {
  if (secret === undefined) return true;
  return (data as Record<string, unknown> | null)?.[RELAY_SECRET_FIELD] === secret;
}

/** Shallow copy of `data` with the secret field removed. */
export function stripTag<T extends object>(data: T): T {
  const copy = { ...(data as Record<string, unknown>) };
  delete copy[RELAY_SECRET_FIELD];
  return copy as T;
}

// `ctor` is a test seam: callers (e.g. makeKeysApi) can inject a fake
// BroadcastChannel constructor. Production omits it and uses the
// module-load-captured _BroadcastChannel.
export function createRelayChannel(
  secret?: string,
  ctor?: new (channel: string) => BroadcastChannel,
): RelayChannel {
  const raw = new (ctor ?? _BroadcastChannel)(RELAY_CHANNEL);

  function post(msg: object): void {
    raw.postMessage(secret !== undefined ? { ...msg, [RELAY_SECRET_FIELD]: secret } : msg);
  }

  function postUntagged(msg: object): void {
    raw.postMessage(msg);
  }

  function onMessage(cb: (data: unknown) => void): () => void {
    const handler = (ev: MessageEvent) => {
      if (secret !== undefined) {
        // Plain === compare is intentional: this is a local inter-context
        // channel, not a password boundary — we enforce origin isolation,
        // not secrecy against a privileged attacker.
        if ((ev.data as Record<string, unknown>)?.[RELAY_SECRET_FIELD] !== secret) return;
        const stripped = { ...(ev.data as Record<string, unknown>) };
        delete stripped[RELAY_SECRET_FIELD];
        cb(stripped);
      } else {
        cb(ev.data);
      }
    };
    raw.addEventListener('message', handler);
    return () => raw.removeEventListener('message', handler);
  }

  function close(): void {
    raw.close();
  }

  return { post, postUntagged, onMessage, raw, close };
}
