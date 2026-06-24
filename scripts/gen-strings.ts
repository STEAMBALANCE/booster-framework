#!/usr/bin/env bun
/**
 * gen-strings.ts — local code generator for booster-framework's strings.
 *
 * This is the per-repo version that runs after the F.2 repo lift. It reads
 * a single JSON source:
 *   - strings/ru.json                  (framework + general)
 *
 * Emits one generated file:
 *   - src/generated/messages.ts        (typesafe-i18n dict from strings/ru.json)
 *
 * Schema matches the root gen-strings.ts at steambooster/scripts/gen-strings.ts
 * (booster-framework subset) so output is byte-identical pre- and post-lift.
 *
 * Exit codes:
 *   0  — success
 *   1  — schema validation failure (with stderr diagnostic list)
 *   2  — filesystem failure
 *   3  — strings/ru.json missing or unreadable
 *
 * CLI: bun run scripts/gen-strings.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

function findRepoRoot(): string {
  // Walk upward from process.cwd() until we hit a directory with a repo marker
  // (bun.lock / .git) or a staged strings/ru.json fixture. Walking from cwd
  // (rather than from import.meta.dir) preserves the gen-strings test harness
  // contract — it spawns gen-strings with cwd=<temp dir> and expects exit 3
  // when no fixture is staged.
  let cur = resolve(process.cwd());
  while (true) {
    if (existsSync(`${cur}/strings/ru.json`)) return cur;
    if (existsSync(`${cur}/bun.lock`) || existsSync(`${cur}/.git`)) return cur;
    const parent = dirname(cur);
    if (parent === cur) {
      return process.cwd();
    }
    cur = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const FW_JSON   = join(REPO_ROOT, 'strings', 'ru.json');

const FW_ALLOWED    = new Set(['framework', 'general']);
const ALLOWED_TYPES = new Set(['string', 'number']);

type StringsDict = Record<string, unknown>;

function fail(code: number, msg: string): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function readJsonAt(path: string, label: string): StringsDict {
  if (!existsSync(path)) {
    fail(3, `${label} not found at ${path}`);
  }
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { fail(3, `${label} unreadable: ${e}`); }
  try { return JSON.parse(raw); }
  catch (e) { fail(1, `${label} parse error: ${e}`); }
}

function validate(root: StringsDict, allowed: Set<string>, label: string): void {
  const errors: string[] = [];
  const allowedList = [...allowed].join('/');

  for (const k of Object.keys(root)) {
    if (!allowed.has(k))
      errors.push(`forbidden top-level key '${k}' (allowed: ${allowedList})`);
  }
  for (const required of allowed)
    if (!(required in root)) errors.push(`missing top-level key '${required}'`);

  let leafCount = 0;
  function walk(node: unknown, path: string[]): void {
    if (typeof node === 'string') {
      leafCount++;
      const errorsBefore = errors.length;
      if (node.length === 0) errors.push(`${path.join('.')}: empty value`);
      if (/\s$/.test(node)) errors.push(`${path.join('.')}: trailing whitespace`);
      if (/\r/.test(node)) errors.push(`${path.join('.')}: contains \\r`);
      if (/\{\{|\}\}/.test(node)) errors.push(`${path.join('.')}: forbidden '{{' or '}}'`);
      if (/\$\{/.test(node)) errors.push(`${path.join('.')}: forbidden '\${'`);
      if (/\$\{?SB_|@SB_/.test(node)) errors.push(`${path.join('.')}: contains substitution-like substring`);
      if (/\|/.test(node)) errors.push(`${path.join('.')}: pipe '|' not supported in placeholders`);
      if (errors.length === errorsBefore) {
        const re = /\{([^}]+)\}/g;
        let m;
        while ((m = re.exec(node)) !== null) {
          const inner = m[1];
          const parts = inner.split(':');
          if (parts.length === 1)
            errors.push(`${path.join('.')}: untyped placeholder {${inner}} (use {name:string} or {name:number})`);
          else if (parts.length > 2)
            errors.push(`${path.join('.')}: malformed placeholder {${inner}}`);
          else if (!ALLOWED_TYPES.has(parts[1]))
            errors.push(`${path.join('.')}: unknown placeholder type '${parts[1]}'`);
        }
      }
      return;
    }
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (!/^[a-z][a-z0-9_]*$/.test(k))
          errors.push(`${[...path, k].join('.')}: key must match /^[a-z][a-z0-9_]*$/`);
        walk(v, [...path, k]);
      }
      return;
    }
    errors.push(`${path.join('.')}: leaf must be string, got ${typeof node}`);
  }
  for (const top of allowed)
    if (root[top] !== undefined) walk(root[top], [top]);

  if (leafCount > 500) errors.push(`total leaf count ${leafCount} exceeds 500-key cap`);

  if (errors.length > 0) fail(1, errors.map(e => `${label}: ${e}`).join('\n'));
}

function escapeForTsLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\\'')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function renderTsNode(node: unknown, indent: number): string {
  if (typeof node === 'string') return `'${escapeForTsLiteral(node)}'`;
  if (node && typeof node === 'object') {
    const entries = Object.entries(node).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.length === 0) return '{}';
    const pad = ' '.repeat(indent * 2);
    const inner = entries.map(([k, v]) => `${pad}  ${k}: ${renderTsNode(v, indent + 1)},`).join('\n');
    return `{\n${inner}\n${pad}}`;
  }
  throw new Error(`unexpected node type: ${typeof node}`);
}

function emitTsHeader(contentsLabel: string): string[] {
  return [
    '// AUTO-GENERATED from strings/ru.json — DO NOT EDIT.',
    `// Contents: ${contentsLabel}`,
    '',
    "import type { BaseTranslation } from 'typesafe-i18n';",
    '',
  ];
}

function emitTsFooter(typeName: string): string[] {
  return [
    '',
    'export default ru;',
    `export type ${typeName} = typeof ru;`,
    '',
  ];
}

function emitTsDictFromPerPackage(pkg: StringsDict, primarySub: 'framework'): string {
  const sub = pkg[primarySub] ?? {};
  const general = pkg.general ?? {};
  const cap = primarySub.charAt(0).toUpperCase() + primarySub.slice(1);
  const lines: string[] = [
    ...emitTsHeader(`${primarySub}.* and general.* subsets only.`),
    'const ru = {',
    `  ${primarySub}: ${renderTsNode(sub, 1)},`,
    `  general: ${renderTsNode(general, 1)},`,
    '} as const satisfies BaseTranslation;',
    ...emitTsFooter(`${cap}Translation`),
  ];
  return lines.join('\n');
}

function writeFileEnsuringDir(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

const fwDict = readJsonAt(FW_JSON, 'strings/ru.json');

validate(fwDict, FW_ALLOWED, 'strings/ru.json');

try {
  writeFileEnsuringDir(
    join(REPO_ROOT, 'src', 'generated', 'messages.ts'),
    emitTsDictFromPerPackage(fwDict, 'framework'));
} catch (e) {
  fail(2, `gen-strings: filesystem write failed: ${e}`);
}

function countTsKeys(pkg: StringsDict, primarySub: 'framework'): number {
  function flatten(node: unknown, path: string[], out: Map<string, string>): void {
    if (typeof node === 'string') { out.set(path.join('.'), node); return; }
    if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) flatten(v, [...path, k], out);
  }
  const flatPkg = new Map<string, string>();
  flatten(pkg[primarySub] ?? {}, [primarySub], flatPkg);
  const flatGeneral = new Map<string, string>();
  flatten(pkg.general ?? {}, ['general'], flatGeneral);
  return flatPkg.size + flatGeneral.size;
}

const fwCount = countTsKeys(fwDict, 'framework');
process.stdout.write(`gen-strings: wrote framework=${fwCount} TS keys\n`);
