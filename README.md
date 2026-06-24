# @steambalance/booster-framework

`@steambalance/booster-framework` — TypeScript-фреймворк, который нативный
injector `steambooster.exe` подкладывает в Steam через Chrome DevTools Protocol.
Фреймворк публикует `window.sb` — стабильную поверхность, через которую
плагины регистрируют кнопки в шапке, popup'ы, page-mod'ы для
встроенного браузера, конфиги и общую шину сообщений.

**Status.** Active development. Public API (`src/api/api-types.ts`)
является source-of-truth и считается стабильным в рамках `apiVersion: 1`;
любое breaking-изменение `api-types.ts` обязано обновить
[`docs/plugin-contract.md`](./docs/plugin-contract.md) в одном коммите.

**License.** MIT (см. [`LICENSE`](./LICENSE)).

## Документация для авторов плагинов

Вся пользовательская документация — в [`docs/`](./docs/README.md).
Туториал, reference по каждой sub-API'и, troubleshooting.

| Файл | Когда читать |
|------|--------------|
| [`docs/README.md`](./docs/README.md) | Оглавление, индекс. |
| [`docs/getting-started.md`](./docs/getting-started.md) | Первый плагин: `gh repo create` → live-кнопка в Steam (~30 мин). |
| [`docs/plugin-contract.md`](./docs/plugin-contract.md) | `sb.plugins.register`, `PluginManifest`, `PluginContext`, lifecycle. |
| [`docs/capabilities.md`](./docs/capabilities.md) | Capability'и (Ui / Steam / Configs / Bus / Pages / Keys), effective grant. |
| [`docs/lifecycle.md`](./docs/lifecycle.md) | init / cleanup тайминги, rollback, hot-reload (dev). |
| [`docs/ui-api.md`](./docs/ui-api.md) | `sb.ui.addHeaderButton`, `attachPopup`, `openWindow`, `openExternalWindow`. |
| [`docs/steam-api.md`](./docs/steam-api.md) | `sb.steam.openUrl`, `getCurrentUser*`, `onUserChange`, `getStoreCountry`. |
| [`docs/configs-api.md`](./docs/configs-api.md) | `sb.configs.read` / `write`, per-plugin namespace, libsodium-шифрование, квота. |
| [`docs/bus-api.md`](./docs/bus-api.md) | `sb.bus.publish` / `subscribe`, cross-target broadcast. |
| [`docs/pages-api.md`](./docs/pages-api.md) | `sb.pages.register`, URL-matched mount/unmount. |
| [`docs/scope-api.md`](./docs/scope-api.md) | `sb.scope.*`, AbortController-паттерны, auto-cleanup. |
| [`docs/testing.md`](./docs/testing.md) | `@steambalance/booster-framework/testing`, `createTestPluginContext`. |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md) | apiVersion mismatch, capability denial, hot-reload, port conflict. |

## Public API surface

Единственный source-of-truth публичной поверхности —
[`src/api/api-types.ts`](./src/api/api-types.ts). Любое расхождение между
этим файлом и [`docs/`](./docs/README.md) — баг в документации, не в
коде. Каждый docs-файл реферирует конкретные интерфейсы и константы из
`api-types.ts`; примеры в docs прогоняются через compile-harness, и
их сигнатуры синхронизированы с кодом.

Плагин-author импортирует ТОЛЬКО `@steambalance/booster-framework` (top-level
import):

```ts
import {
  ContextKind,
  Capability,
  type PluginContext,
  type PluginManifest,
} from '@steambalance/booster-framework';
```

Sub-paths типа `@steambalance/booster-framework/relay` НЕ являются публичными.
Любой `relay`/`bridge`/`registry`/`steam-internals`-импорт из плагина —
breakage waiting to happen и блокируется linter'ом приёмки.

## Quick example

```ts
import { ContextKind, Capability } from '@steambalance/booster-framework';

declare const sb: { plugins: { register: (m: unknown) => void } };
declare const __SB_PLUGIN_VERSION__: string;

sb.plugins.register({
  id: 'example-plugin',
  version: __SB_PLUGIN_VERSION__,
  apiVersion: 1,
  displayName: 'Example Plugin',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  async init(ctx) {
    const handle = ctx.sb?.ui?.addHeaderButton({
      id: 'hello',
      label: 'Hello',
      onClick: () => ctx.log.info('clicked'),
    });
    return () => handle?.remove();
  },
});
```

Полный walkthrough — в
[`docs/getting-started.md`](./docs/getting-started.md).

## Установка фреймворка как зависимости плагина

`@steambalance/booster-framework` публикуется в **GitHub Packages** (npm-реестр
GitHub). GitHub Packages требует аутентификации даже для публичных пакетов,
поэтому перед `bun install` нужно один раз настроить реестр и токен.

1. Создай **personal access token (classic)** с правом `read:packages`:
   GitHub → Settings → Developer settings → Personal access tokens (classic).

2. Пропиши реестр для scope `@steambalance`. Шаблон плагина уже содержит
   `.npmrc` с маршрутизацией scope; тебе остаётся добавить токен — либо в
   пользовательский `~/.npmrc`:

   ```ini
   @steambalance:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=ghp_ТВОЙ_ТОКЕН
   ```

   либо через переменную окружения `NODE_AUTH_TOKEN` (её читает `.npmrc`
   шаблона: `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`):

   ```pwsh
   $env:NODE_AUTH_TOKEN = "ghp_ТВОЙ_ТОКЕН"
   ```

3. Создай репозиторий из шаблона и установи зависимости:

   ```pwsh
   gh repo create my-plugin --template STEAMBALANCE/booster-plugin-template --clone
   cd my-plugin
   bun install
   ```

Полный путь от пустого репозитория до работающего плагина —
[`docs/getting-started.md`](./docs/getting-started.md).

> **Переезд на публичный npm.** Если позже пакет переедет на npmjs.com,
> import-спецификатор `@steambalance/booster-framework` не меняется: достаточно
> убрать строки `.npmrc` (публичный npm не требует токена) — код плагинов
> остаётся как есть.

## Разработка самого фреймворка

Раздел для контрибьюторов в `booster-framework` (не для авторов плагинов).

### Repo layout

```
booster-framework/
├── src/
│   ├── api/              # Публичная поверхность (api-types.ts +
│   │                       # реализация sub-API: ui/, steam/, configs/,
│   │                       # bus/, pages/, keys/, scope/, logger/, …)
│   ├── plugins/          # PluginRegistry, lifecycle, capability gating
│   ├── relay/            # Shared-context relay: bridge между Main и
│   │                       # Web-контекстами; internal helpers (tabbed-shell,
│   │                       # user-data, external-window, etc.)
│   ├── steam-internals/  # Низкоуровневые врапперы над Steam globals
│   ├── testing/          # @steambalance/booster-framework/testing entry
│   ├── generated/        # typesafe-i18n генерация (RU strings)
│   ├── bridge.ts         # Native IPC bridge (CDP message handlers)
│   ├── registry.ts       # plugin registry (engine-side mounting)
│   ├── i18n.ts           # typesafe-i18n runtime init
│   ├── index.ts          # Bundle entry point
│   └── native-warn.ts    # Production-only warning helpers
├── docs/                 # Документация для плагин-авторов (RU)
├── examples/             # Минимальные working snippets для docs
├── tests/                # bun test suites (api, relay, plugins, …)
├── strings/              # ru.json — framework + general namespaces
├── build.ts              # bun build → out/booster-framework.js (IIFE, инжектится
│                           # в Steam) + dist/index.js (ESM, npm-точка входа)
├── package.json
├── tsconfig.json
└── README.md             # (this file)
```

### Build / dev / test

```pwsh
cd booster-framework
bun install
bun run build                   # → out/booster-framework.js (IIFE, инжектится в Steam)
                                #   + dist/index.js (ESM, npm-точка входа)
bun test                        # все тест-сьюты
bun test tests/plugins-*.test.ts  # точечно
```

В рамках полного цикла фреймворк собирается dev-оркестратором нативного
инжектора вместе с плагинами.

### Test discipline

`@steambalance/booster-framework` следует общим правилам репозитория:

- TDD red-first для логики (см.
  [`CLAUDE.md`](./CLAUDE.md) «Test discipline»).
- Тесты фиксируют intended behavior, а не текущую реализацию.
- Никаких `SB_TESTS_ENABLED` seam'ов внутри публичного API — публичные
  типы НЕ имеют test-only fields.

### Внутренние модули — Не публичный API

`relay/`, `steam-internals/`, `plugins/`, `bridge.ts`, `registry.ts` —
internal. Менять можно свободно, но любое breaking изменение публичной
поверхности (`api-types.ts`) обязано обновить
[`docs/plugin-contract.md`](./docs/plugin-contract.md) в том же коммите
и пройти `requesting-code-review` против errata.

`relay/`-модули (tabbed-shell, user-data, external-window, etc.) —
это helper'ы для SharedJSContext'а Steam'овской CEF, где `window.sb`
не доступен. Они используются только bridge'ом и собственно
relay-bootstrap'ом, и не должны импортироваться плагином.

### Связанные репозитории

- `booster-plugins` — official плагины: https://github.com/STEAMBALANCE/booster-plugins
- `booster-plugin-template` — стартер для внешних авторов:
  https://github.com/STEAMBALANCE/booster-plugin-template

Нативный инжектор (`steambooster.exe`), который загружает этот рантайм в
Steam, — отдельная внутренняя зависимость и в публичный набор репозиториев
не входит.
