# booster-framework

`@steambalance/booster-framework` — TypeScript runtime that the
`steambooster.exe` native injector lifts into Steam over CDP. Exposes the
public `window.sb` surface (UI, Steam, Configs, Bus, Pages, Keys, Scope,
Logger) and runs plugin lifecycle / capability gating. This repo is part
of the `STEAMBALANCE` GitHub org. The shipped output is a single IIFE
(`out/booster-framework.js`) consumed by the injector via the signed v2
manifest; `dist/index.js` is a separate non-minified ESM build used as
the npm package entry — it is not injected.

> **Project-wide conventions** (strings, URLs, error handling, test
> discipline, security primitives) are maintained by the native injector
> and apply repo-wide. This file extends/specializes for
> booster-framework-local work. If a global rule disagrees with something
> below, the global rule wins.

## Repo layout

```
booster-framework/
├── src/
│   ├── api/              # Public surface (api-types.ts + ui/, steam/,
│   │                     # configs/, bus/, pages/, scope/, logger/, …)
│   ├── plugins/          # PluginRegistry, lifecycle, capability gating
│   ├── relay/            # Shared-context relay: bridge between Main and
│   │                     # Web contexts; internal helpers (tabbed-shell,
│   │                     # user-data, external-window, …)
│   ├── steam-internals/  # Low-level wrappers over Steam globals
│   ├── testing/          # @steambalance/booster-framework/testing entry
│   ├── generated/        # typesafe-i18n codegen (do not edit by hand)
│   ├── bridge.ts         # Native IPC bridge (CDP message handlers)
│   ├── registry.ts       # Plugin registry (engine-side mounting)
│   ├── i18n.ts           # typesafe-i18n runtime init
│   ├── index.ts          # Bundle entry point
│   └── native-warn.ts    # Production-only warning helpers
├── docs/                 # Plugin-author documentation (RU)
├── examples/             # Minimal working snippets used by docs
├── tests/                # bun test suites (api, relay, plugins, …)
├── scripts/
│   └── gen-strings.ts    # Per-repo codegen from strings/ru.json
├── strings/
│   └── ru.json           # framework + general namespaces only
├── build.ts              # bun build → out/booster-framework.js (IIFE, injected)
│                         #            + dist/index.js (ESM, npm entry)
├── package.json
├── tsconfig.json
├── CLAUDE.md             # (this file)
└── README.md             # External-facing intro + plugin-author pointer
```

## Related repositories

Public repos in the `STEAMBALANCE` org:

```
booster-framework/         ← THIS repo (TypeScript runtime, public window.sb)
booster-plugins/           ← internal plugins (depend on this repo)
booster-plugin-template/   ← external-plugin starter (depends on this repo)
```

The native injector (`steambooster.exe`) that loads this runtime into
Steam is a separate, internal dependency — not part of this repo.

**Standalone work here is OK** for framework-internal changes: refactor
internal modules, add a new `sb.api.*` method, tighten capability
gating, fix a relay race, write a bun test. `bun test` covers the
in-repo behaviour fully.

**For end-to-end testing** — drive the native injector's dev workflow
(obtain the dev build from your operator / the official portal). Its dev
orchestrator watches this repo's `out/booster-framework.js`, the testserver
rebuilds the signed v2 manifest with the new sha256, and the running
steambooster.exe hot-updates inside Steam. Live changes land in
~3 seconds.

## Conventions

**Public API surface — `src/api/api-types.ts` is canonical.** Any
breaking change here (renamed field, changed signature, removed
capability) MUST update `docs/plugin-contract.md` in the same commit.
Same applies to `docs/capabilities.md` when adding/removing a
`Capability` enum value, and to the relevant `docs/<area>-api.md` when
adding/removing methods. Docs examples are compiled through a harness
that imports from `api-types.ts` — if a docs snippet stops compiling,
fix the docs, not `api-types.ts`.

**Sub-paths are NOT public.** Plugin authors import only from
`@steambalance/booster-framework` (top-level). Anything under
`@steambalance/booster-framework/relay`, `…/plugins`, `…/steam-internals` is
internal and may break without notice. A linter at acceptance rejects
non-top-level imports.

**Strings.** All user-visible strings are Russian and live in
`strings/ru.json` under the `framework` + `general` namespaces (see
the primary CLAUDE.md for the cross-repo namespace split). To add a
string:

1. Edit `strings/ru.json` (this repo).
2. Run `bun run scripts/gen-strings.ts`.
3. Call via `LL.framework.<key>()` or `LL.general.<key>()`.

The `no-hardcoded-ru` regression guard scans this repo; Cyrillic
literals outside `*/generated/*` are forbidden without an escape-hatch
pragma (`// strings-allow-cyrillic: file` or trailing
`// strings-allow-cyrillic`).

**URLs.** This repo MUST NOT hardcode URLs. URL constants belong in
plugin repos (`../booster-plugins/packages/<plugin>/src/urls.ts`). The
`no-hardcoded-urls` guard enforces this — its allowlist matches only
the plugin urls.ts files, never framework code.

**Tests.** `bun test` runs every suite under `tests/`. Tests fix
intended behavior — they are effectively immutable (per the project's
TDD policy). A failing test means fix the code, not the test. Some
suites skip themselves when the native injector's resources are absent
(the injector-resource skip guards) — `bun test` is still green standalone.

**No `SB_TESTS_ENABLED` seams in the public surface.** Public types in
`api-types.ts` MUST NOT have test-only fields. Test seams live in
internal modules (`plugins/`, `relay/`, `bridge.ts`) and are
implementation details.

## Build / dev / test

```pwsh
cd booster-framework
bun install
bun run build                   # → out/booster-framework.js (IIFE; injector + testserver) + dist/index.js (ESM, npm)
bun run scripts/gen-strings.ts  # regenerate src/generated/messages.ts
bun test                        # full suite
bun test tests/plugins-*.test.ts  # filter by glob
```

For the full system loop (testserver + injector + Steam), drive the
native injector's dev workflow.

## Internal modules — not public API

`relay/`, `steam-internals/`, `plugins/`, `bridge.ts`, `registry.ts`
are internal. Refactor freely; only `src/api/api-types.ts` is the
breaking-surface to watch.

`relay/` modules (tabbed-shell, user-data, external-window) are
helpers for Steam's SharedJSContext (a separate CEF realm where
`window.sb` does not exist). They are reachable only through the
internal bridge and the relay bootstrap; plugins must not import them.

## See also

- `docs/README.md` — index of plugin-author documentation.
- `docs/plugin-contract.md` — `register`, `PluginManifest`,
  `PluginContext`, lifecycle.
- `docs/capabilities.md` — full capability matrix.
- `README.md` — external-facing intro + quick example.
