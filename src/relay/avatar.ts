import type { GetAvatarRequest } from './protocol';
import type { RelayPoster } from './channel';

// Downscale target for the frontend-display avatar. A small JPEG data URI keeps
// the account-valuation payload light (~a few KB) vs the raw local PNG (tens of
// KB), while staying crisp enough for a header/profile thumbnail.
const AVATAR_MAX_PX = 128;
const AVATAR_MIME = 'image/jpeg';
const AVATAR_QUALITY = 0.85;

// Reads the current user's locally-cached avatar and returns a self-contained
// data URI the steambalance.cc frontend can render directly. Rationale: the
// public avatar CDN URL isn't derivable client-side (no reliable avatar hash in
// the client), and the loopback avatarcache path isn't reachable from the
// content browser — so we pack the bytes here. This runs in SharedJSContext,
// same origin as steamloopback.host, so the canvas is NOT tainted and toDataURL
// works. Never throws across the relay; posts dataUrl:undefined on any failure.
export async function handleGetAvatar(msg: GetAvatarRequest, bc: RelayPoster): Promise<void> {
  let dataUrl: string | undefined;
  try { dataUrl = await encodeLocalAvatar(msg.steamId); } catch { dataUrl = undefined; }
  bc.postMessage({ kind: 'avatar-ok', requestId: msg.requestId, dataUrl });
}

async function encodeLocalAvatar(steamId: string): Promise<string | undefined> {
  // steamId is our own resolved SteamID64; validate before interpolating it
  // into the fetch path (defense-in-depth against a malformed value).
  if (!/^[0-9]{1,20}$/.test(steamId)) return undefined;
  const resp = await fetch(`https://steamloopback.host/avatarcache/${steamId}.png`);
  if (!resp.ok) return undefined;
  const bmp = await createImageBitmap(await resp.blob());
  try {
    const scale = Math.min(1, AVATAR_MAX_PX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL(AVATAR_MIME, AVATAR_QUALITY);
  } finally {
    bmp.close();
  }
}
