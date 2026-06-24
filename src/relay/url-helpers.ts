declare const __SB_PRODUCTION__: boolean;

/** Canonicalise URL via WHATWG URL parser:
 *   - lowercase scheme + host
 *   - drop default port (443 для https)
 *   - normalize empty path to '/'
 *  Throws TypeError for invalid URL. */
export function canonicalUrl(input: string): string {
  return new URL(input).href;
}

/** Strip query + fragment from URL для production logs. Keeps scheme
 *  + host + path. Used to redact payment session tokens from
 *  console.error. */
export function redactUrl(input: string): string {
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<malformed-url>';
  }
}

function stripUrls(s: string): string {
  return s.replace(/https?:\/\/[^\s'"]+/g, m => redactUrl(m));
}

/** Production-only export для тестов (verifies prod-mode logic). */
export const stripUrlsForTest = stripUrls;

/** Pure helper: production path is independent of the build-time define.
 *  Tests can exercise the prod branch directly by passing `prod=true`,
 *  rather than trying to flip a global at runtime. */
export function redactErrPure(e: unknown, prod: boolean): unknown {
  if (!prod) return e;
  if (e instanceof Error) {
    return new Error(stripUrls(e.message));
  }
  if (typeof e === 'string') return stripUrls(e);
  return e;
}

/** Redact Error/string: in production strips URL query+fragment.
 *  In dev passes through unchanged для full diagnostic. Thin wrapper
 *  over `redactErrPure` that reads the build-time `__SB_PRODUCTION__`
 *  define — bun's minifier dead-code-eliminates the dev branch in
 *  production bundles. */
export function redactErr(e: unknown): unknown {
  const prod = typeof __SB_PRODUCTION__ !== 'undefined' && __SB_PRODUCTION__;
  return redactErrPure(e, prod);
}
