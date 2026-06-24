// Shared navigation safety checks used by public APIs and relay sinks.
// The relay must validate again because callers can bypass public API helpers.

/** @internal */
export function isUrlSafeForNavigation(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '') return false;
  return true;
}

export function safeHostForLog(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '<malformed>';
  }
}
