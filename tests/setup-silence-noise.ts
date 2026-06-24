// framework/tests/setup-silence-noise.ts
//
// Bun-test preload that filters out a small allow-list of known-incidental
// `console.warn` / `console.error` lines so the test output stays focused
// on real signal. Each entry MUST have a justification: the diagnostic
// fires on a path the test is not exercising, OR the test deliberately
// triggers the path and a per-test `expectConsoleError` wrapper already
// asserts the contract.
//
// IMPORTANT: only EXACT-substring matches go here. Any console.warn /
// console.error containing a different message still surfaces — so a
// regression that changes the wording or introduces a NEW warning will
// be loud, not silent.

const SILENCED_WARN_SUBSTRINGS: readonly string[] = [
  // Fires from `startRelay()` (shared-context.ts) when window.MainWindowBrowserManager
  // isn't installed — a setup most tests skip because they don't
  // exercise the external-window relay branch. In production this
  // warn is real signal (MWBM should always be present after
  // MainShellReady), so it stays at console.warn — only the test
  // output is filtered.
  '[booster-relay] MWBM not available at bootstrap',
];

const originalWarn = console.warn;
console.warn = (...args: unknown[]): void => {
  const line = args.map(a =>
    a instanceof Error ? a.message : typeof a === 'string' ? a : String(a),
  ).join(' ');
  if (SILENCED_WARN_SUBSTRINGS.some(s => line.includes(s))) return;
  originalWarn(...args);
};
