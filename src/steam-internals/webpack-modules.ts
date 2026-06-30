// Content-based webpack module resolution. Steam renumbers webpackChunksteamui
// module ids between client versions, so we NEVER hardcode an id — we resolve a
// module by a stable signature string (a ServiceMethod route, a distinctive
// source substring) found in the factory source. Resolved __webpack_require__ is
// cached per page load.

type WebpackRequire = ((id: string | number) => any) & { m: Record<string, (...a: any[]) => any> };

let cachedReq: WebpackRequire | undefined;

/** Acquire __webpack_require__ by pushing a runtime chunk that captures it. */
export function getWebpackRequire(): WebpackRequire | undefined {
  if (cachedReq) return cachedReq;
  let w: { push?: (x: unknown[]) => void } | undefined;
  try { w = (window as unknown as { webpackChunksteamui?: { push?: (x: unknown[]) => void } }).webpackChunksteamui; } catch { return undefined; }
  if (!w || typeof w.push !== 'function') return undefined;
  let req: WebpackRequire | undefined;
  try {
    const key = '__sb_' + Math.random().toString(36).slice(2);
    w.push([[key], {}, (r: WebpackRequire) => { req = r; }]);
  } catch { return undefined; }
  if (req && req.m) cachedReq = req;
  return cachedReq;
}

/** Find the first module whose factory source contains `signature` (a string,
 *  or an array of strings that must ALL be present), instantiate it, and return
 *  its exports. The array form narrows past over-broad single substrings (e.g.
 *  a bare `'Init('` matches dozens of modules). undefined on miss / any error. */
export function resolveModuleByContent(signature: string | string[]): unknown | undefined {
  const req = getWebpackRequire();
  if (!req) return undefined;
  const needles = Array.isArray(signature) ? signature : [signature];
  try {
    for (const id of Object.keys(req.m)) {
      let src: string;
      try { src = req.m[id]!.toString(); } catch { continue; }
      if (needles.every((n) => src.includes(n))) {
        try { return req(id); } catch { continue; }
      }
    }
  } catch { return undefined; }
  return undefined;
}

/** Return the first export value of `mod` for which `pred` is true. */
export function pickExport(mod: unknown, pred: (v: unknown) => boolean): unknown | undefined {
  if (!mod || typeof mod !== 'object') return undefined;
  for (const k of Object.keys(mod as Record<string, unknown>)) {
    try { const v = (mod as Record<string, unknown>)[k]; if (pred(v)) return v; } catch { /* ignore */ }
  }
  return undefined;
}

/** test-only: reset the cached webpack require between tests. */
export function __resetWebpackCacheForTest(): void { cachedReq = undefined; }
