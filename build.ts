#!/usr/bin/env bun
import { build } from 'bun';
import { mkdirSync, existsSync, watch, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Inlined stylesheets ship as JS string literals, so bun's JS minifier never
// touches them. Run them through bun's built-in CSS minifier in production
// (strips comments + whitespace, single line); keep raw in dev for readable
// injected <style> debugging. Injected via `define` so the raw `type: 'text'`
// import is const-folded out of the shipped bundle.
async function loadCss(path: string, minify: boolean): Promise<string> {
  if (!minify) return readFileSync(path, 'utf8');
  const res = await build({ entrypoints: [path], minify: true });
  if (!res.success) {
    for (const m of res.logs) console.error(m);
    throw new Error(`CSS minify failed: ${path}`);
  }
  return (await res.outputs[0]!.text()).trimEnd();
}

// Override path lets tests build into a tempdir without clobbering the dev
// artefact that developers (and downstream sibling-repo tests) read directly
// from the canonical `out/` location.
const outdir = process.env['SB_BUNDLE_OUT_DIR'] ?? 'out';
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const isProd = process.env['SB_PRODUCTION'] === '1';

// SB_BUNDLE_ENTRY: test-only override for the main IIFE entrypoint.
// When set, only the IIFE bundle is built (testing + esm sub-paths are
// skipped — they require the full src tree). Production and dev always
// use the canonical 'src/index.ts'.
const mainEntry = process.env['SB_BUNDLE_ENTRY'] ?? 'src/index.ts';
const testEntryOverride = !!process.env['SB_BUNDLE_ENTRY'];

async function buildOnce(): Promise<void> {
  const toolbarCss = await loadCss(
    resolve(import.meta.dir, 'src/api/ui-toolbar-styles.css'),
    isProd,
  );
  const wrapperCss = await loadCss(
    resolve(import.meta.dir, 'src/relay/window-wrapper-styles.css'),
    isProd,
  );

  const result = await build({
    entrypoints: [mainEntry],
    outdir,
    naming: 'booster-framework.js',
    format: 'iife',
    target: 'browser',
    // Always minify. In dev: enables dead-code elimination of
    // `if (!__SB_PRODUCTION__) { ... }` branch (impl gates dev-only
    // logging). In prod: produces the shipped bundle directly — open-source
    // plugins don't require obfuscation.
    minify: true,
    sourcemap: isProd ? 'none' : 'external',
    define: {
      __SB_FRAMEWORK_VERSION__: JSON.stringify(
        process.env['SB_FRAMEWORK_VERSION'] ?? '0.0.0-dev',
      ),
      // Replaced by bun at build time. Used as a dead-code-elimination
      // gate for dev-only IPC calls in framework/src/index.ts.
      __SB_PRODUCTION__: JSON.stringify(isProd),
      // Minified (prod) / raw (dev) inlined stylesheets. Each folds the
      // corresponding ternary so the raw `type: 'text'` import is tree-shaken
      // out of the shipped bundle.
      __SB_TOOLBAR_CSS__: JSON.stringify(toolbarCss),
      __SB_WRAPPER_CSS__: JSON.stringify(wrapperCss),
      // No build-time URL baking — runtime reads from sb.manifest.urls
      // (populated by the C++-injected __SB_PLUGINS_MANIFEST__ at bootstrap).
      // Manifest is the single source of truth for all production URLs.
    },
  });

  if (!result.success) {
    for (const m of result.logs) console.error(m);
    throw new Error('build failed');
  }

  console.log(
    `framework built: ${result.outputs.map((o) => o.path).join(', ')}`,
  );

  // Skip secondary builds when running under test entry override — those
  // builds require the full src tree (src/testing/index.ts, src/index.ts).
  if (testEntryOverride) return;

  // Testing sub-path: dist/testing/index.js
  // Emitted as ESM module (not IIFE) — consumed by bun test in plugin repos.
  const testingResult = await build({
    entrypoints: ['src/testing/index.ts'],
    outdir: 'dist/testing',
    naming: 'index.js',
    format: 'esm',
    target: 'node',
    minify: false,
    sourcemap: 'none',
  });

  if (!testingResult.success) {
    for (const m of testingResult.logs) console.error(m);
    throw new Error('build failed');
  }

  console.log(
    `testing helpers built: ${testingResult.outputs.map((o) => o.path).join(', ')}`,
  );

  // dist/index.js: the non-minified ESM build that serves as the npm package
  // entry for `@steambalance/booster-framework` consumers. Not shipped via the
  // manifest (that's out/booster-framework.js, the IIFE above). `.d.ts` files
  // are emitted separately by `tsc --emitDeclarationOnly` (the `build:types`
  // package script, run in the publish pipeline) into dist/ alongside this JS.
  const esmResult = await build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    format: 'esm',
    target: 'browser',
    // Do NOT minify; preserve readable source for plugin authors debugging.
  });

  if (!esmResult.success) {
    for (const m of esmResult.logs) console.error(m);
    throw new Error('build failed');
  }

  console.log(
    `esm build: ${esmResult.outputs.map((o) => o.path).join(', ')}`,
  );
}

const WATCH_DEBOUNCE_MS = 100;
// When SB_BUNDLE_ENTRY is set (test override), watch that entry's parent dir.
// Production and dev always watch the canonical src/ directory.
const SRC_DIR = testEntryOverride
  ? dirname(resolve(import.meta.dir, mainEntry))
  : resolve(import.meta.dir, 'src');

async function watchAndRebuild(): Promise<void> {
  console.log(`[build:watch] watching ${SRC_DIR}/**`);
  let inFlight = false;
  let pending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function fire(): void {
    if (inFlight) { pending = true; return; }
    inFlight = true;
    void buildOnce()
      .catch((e) => { console.error('[build:watch] build failed:', e); })
      .finally(() => {
        inFlight = false;
        if (pending) { pending = false; fire(); }
      });
  }

  const w = watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Ignore generated files — `src/generated/*` to avoid
    // self-rebuild loop (gen-strings.ts may write to src/generated/).
    if (filename.startsWith('generated' + (process.platform === 'win32' ? '\\' : '/'))) return;
    // Useful extensions: .ts, .svelte, .css, .json (domain-relevant).
    if (!/\.(ts|svelte|css|json)$/.test(filename)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, WATCH_DEBOUNCE_MS);
  });

  // Keep process alive in watch mode until Ctrl+C / SIGTERM.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      w.close();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  const watchMode = process.argv.includes('--watch');
  await buildOnce();
  if (!watchMode) return;
  await watchAndRebuild();
}

if (import.meta.main) await main();
