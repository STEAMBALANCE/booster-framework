// tests/build-watch.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'bun';
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TMP_SRC = resolve(ROOT, 'tests/.tmp-watch-src');
const TMP_OUT = resolve(ROOT, 'tests/.tmp-watch-out');

beforeAll(() => {
  rmSync(TMP_SRC, { recursive: true, force: true });
  rmSync(TMP_OUT, { recursive: true, force: true });
  mkdirSync(TMP_SRC, { recursive: true });
  mkdirSync(TMP_OUT, { recursive: true });
  writeFileSync(`${TMP_SRC}/index.ts`, `export const X = 1;\n`);
});

afterAll(() => {
  rmSync(TMP_SRC, { recursive: true, force: true });
  rmSync(TMP_OUT, { recursive: true, force: true });
});

test('build --watch rebuilds within 1500ms after src edit', async () => {
  const child = spawn({
    cmd: ['bun', 'run', 'build.ts', '--watch'],
    cwd: ROOT,
    env: { ...process.env,
      SB_BUNDLE_OUT_DIR: TMP_OUT,
      // SB_BUNDLE_ENTRY: test-only entrypoint override — see build.ts:14-19.
      SB_BUNDLE_ENTRY: `${TMP_SRC}/index.ts`,
    },
    // Use 'ignore' to avoid pipe-buffer blocking the child process.
    stdout: 'ignore',
    stderr: 'ignore',
  });

  // Poll for initial build output
  const outBundle = `${TMP_OUT}/booster-framework.js`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (statSync(outBundle).size > 0) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const initialMtime = statSync(outBundle).mtimeMs;
  const initialContent = readFileSync(outBundle, 'utf8');
  expect(initialContent).toContain('1');  // X = 1

  // Edit source — change X = 1 → X = 42
  writeFileSync(`${TMP_SRC}/index.ts`, `export const X = 42;\n`);

  // Wait for rebuild — up to 1500ms (debounce 100 + build time)
  const editDeadline = Date.now() + 1500;
  let rebuilt = false;
  while (Date.now() < editDeadline) {
    try {
      const mt = statSync(outBundle).mtimeMs;
      if (mt > initialMtime) { rebuilt = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  expect(rebuilt).toBe(true);
  const newContent = readFileSync(outBundle, 'utf8');
  expect(newContent).toContain('42');

  child.kill();
  await child.exited;
}, 15000);
