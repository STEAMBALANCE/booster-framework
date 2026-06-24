# Getting Started

Пошаговый туториал: от пустого репозитория до работающей кнопки в шапке
Steam'а за ≈30 минут. К концу прохождения вы получите свой плагин,
загруженный в живой `steambooster-dev.exe`, с собственным id, иконкой и
обработчиком клика.

## Что такое steambooster и плагины

`steambooster` — нативный Windows-injector, который через Chrome DevTools
Protocol подкладывает в Steam runtime фреймворк `@steambalance/booster-framework`.
Фреймворк публикует `window.sb` — поверхность для UI, конфигов,
межоконной шины и URL-роутера. Ваш плагин — это IIFE-бандл, который вызывает
`sb.plugins.register({...})` и возвращает функцию-cleanup'а.

Каждый плагин получает изолированный `ctx` (own logger, configs,
scope, AbortSignal). Доступ к sub-API'ам внутри `ctx.sb` зависит от
запрошенных capabilities: если capability не выдан, поле просто
`undefined`, и обращение через optional-chaining не падает.

Плагин компилируется отдельно от инжектора. Раздаётся либо через
production-pipeline (подписанный манифест на CDN), либо локально через
флаг `--dev-plugin=<path>` у dev-EXE — этот гайд использует второй
вариант.

## Prerequisites

- Windows 11. Linux/macOS — не поддерживается (Steam target — Windows
  CEF runtime).
- `bun` ≥ 1.3 — [`bun.com`](https://bun.com/).
- GitHub CLI `gh` — для `gh repo create`.
- Установленный Steam. Запускать его вручную с флагами отладки НЕ нужно:
  `steambooster-dev.exe` сам поднимает Steam с `-cef-enable-debugging`
  (а если Steam уже открыт без флага — перезапускает его с флагом).
- ≈30 минут.

> Только Windows 11 проходит регулярный QA. На Windows 10 injector
> запускается, но не входит в support-матрицу.

## Зависимость от фреймворка

Плагин зависит от `@steambalance/booster-framework`. Шаблон уже объявляет эту
зависимость, поэтому ставить фреймворк отдельно не нужно — он подтянется
при `bun install` на шаге 1 из реестра пакетов.

## Step 1 — создать репозиторий из шаблона

```pwsh
cd C:\work\plugins
gh repo create my-plugin --template STEAMBALANCE/booster-plugin-template --clone --private
cd my-plugin
bun install
```

`gh repo create --template` форкает [`booster-plugin-template`](https://github.com/STEAMBALANCE/booster-plugin-template)
под ваш аккаунт; `--clone` сразу клонирует к вам на диск; `--private`
держит репу приватной до релиза. После `bun install` директория
содержит:

```
my-plugin/
├── package.json
├── tsconfig.json
├── build.ts
├── src/
│   ├── index.ts
│   └── plugin-meta.ts
└── tests/
```

## Step 2 — задать `id`, `displayName`, версию

Откройте `package.json` и поменяйте:

- `"name": "booster-plugin-my-plugin"` — на свой уникальный id, например
  `"name": "booster-plugin-balance-watcher"`.
- `"version": "0.0.1"` — оставьте на первом проходе; перед первым
  публичным релизом поднимите до `0.1.0`.
- `"description"` — короткое описание.

`name` важен: `build.ts` извлекает из него часть после `booster-plugin-` и
использует как id в имени бандла (`out/<id>-<version>.js`).

Затем откройте `src/plugin-meta.ts` и обновите `id` (без `booster-plugin-`
префикса), `version`, `contextKinds`, `grantedCapabilities`. `build.ts`
при запуске сверяет `pluginMeta.id` с `package.json::name` и упадёт с
ошибкой, если они не совпадают — это страховочная сетка от случайного
деплоя под id шаблона.

> **Ограничения на plugin id.** Регексп — `^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$`
> (см. `PLUGIN_ID_RE` рядом с `PluginManifest.id` в `api-types.ts`):
> начинается со строчной латинской буквы, дальше строчные буквы и цифры,
> дефис допустим только внутри (не первым и не последним символом), длина
> от 2 символов. Префикс `booster-` зарезервирован за нашими внутренними
> плагинами (`STEAMBALANCE/booster-plugins`) — внешние плагины выбирают другой
> префикс.

## Step 3 — отредактировать `src/plugin-meta.ts` и `src/index.ts`

Шаблон разделяет метаданные плагина на два файла:

- **`src/plugin-meta.ts`** — `id`, `version`, `apiVersion`,
  `contextKinds`, `urlPatterns`, `grantedCapabilities`. Эти поля
  `build.ts` записывает в `.meta.json` sidecar рядом с бандлом. Sidecar —
  механизм dev-режима: при локальной загрузке через `--dev-plugin`
  injector читает его, чтобы узнать capabilities и contextKinds плагина
  до выполнения бандла. В production те же метаданные берутся из записи
  плагина в подписанном манифесте — на CDN sidecar не публикуется.
- **`src/index.ts`** — вызов `sb.plugins.register({...})`. Импортирует
  `pluginMeta` из `plugin-meta.ts` и расширяет его через `...pluginMeta`,
  добавляя `displayName`, `description` и `init(ctx)`.

Обновите оба файла под свой плагин. Ниже — упрощённый цельный пример
`register` (поля выписаны явно, для наглядности; в самом шаблоне
`id`/`version`/`contextKinds`/`capabilities` приходят из `plugin-meta.ts`
через `...pluginMeta`):

```ts
import {
  ContextKind,
  Capability,
  type PluginContext,
} from '@steambalance/booster-framework';

declare const sb: {
  plugins: { register: (m: unknown) => void };
};

sb.plugins.register({
  id: 'my-plugin',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Мой плагин',
  description: 'Hello-world plugin from booster-plugin-template.',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  init(ctx: PluginContext): () => void {
    ctx.log.info('hello from my-plugin');

    const button = ctx.sb.ui.addHeaderButton({
      id: 'my-plugin-btn',
      label: 'Привет',
      onClick: () => {
        ctx.log.info('button clicked');
      },
    });

    return () => {
      button.remove();
      ctx.log.info('my-plugin cleanup');
    };
  },
});
```

Что здесь происходит:

- **`ContextKind.Main`** — плагин получит `init` только в Main shell
  Steam'а (главное окно). Другие kinds: `Shared`, `TabbedBrowser`,
  `Web`. См. [`./plugin-contract.md`](./plugin-contract.md).
- **`Capability.Ui`** — запрашиваем UI capability. Этого достаточно для
  `addHeaderButton`. Другие defaults: `steam`, `configs`, `bus`,
  `pages`, `keys`. См. [`./capabilities.md`](./capabilities.md).
- **`displayName`** — обязательное human-readable имя (string, не
  optional). Идёт в логи, tray-меню, потенциально в admin-UI.
- **`apiVersion: 1`** — текущая версия API. Если фреймворк не
  поддерживает заявленную версию, плагин пропускается с warn-логом
  без падения остальных. См.
  [`./troubleshooting.md`](./troubleshooting.md).
- **`init(ctx)`** — может вернуть синхронную или асинхронную cleanup
  function. Используйте `ctx.scope.*` для таймеров, fetch'а и
  listener'ов — они автоматически снимутся на rollback. См.
  [`./scope-api.md`](./scope-api.md).

> **Импортируйте константы, а не литералы.** Всегда `ContextKind.Main`,
> а не `'main'`. Опечатка в строке (`'mian'`) уйдёт в
> cross-validation skip с warn-логом — плагин просто не запустится, и
> искать причину долго.

## Step 4 — сборка

```pwsh
bun run build
```

Получите `out/<id>-<version>.js` — IIFE bundle, готовый к
загрузке в Steam. Минификация выключена по умолчанию; для prod-сборки
будет `SB_PRODUCTION=1 bun run build`.

## Step 5 — забрать `steambooster-dev.exe`

Для локальной разработки нужна dev-сборка нативного инжектора. Dev-EXE
имеет отстёгнутые dev-only CLI флаги, dev-pubkey и включённые test-seam'ы
— отличается от prod-EXE на уровне preprocessor'а. Получите свежую
dev-сборку у оператора / с официального портала.

Запускать prod-EXE с `--dev-plugin=` не получится: флаг
compile-out'нут в production-сборке.

## Step 6 — запуск

Запускать Steam вручную не нужно — `steambooster-dev.exe` сам поднимет его
с `-cef-enable-debugging` (а если Steam уже открыт без флага —
перезапустит с флагом):

```pwsh
.\steambooster-dev.exe --manifest-poll-interval=5 --dev-plugin=.\out\my-plugin-0.0.1.js
```

`--dev-plugin=<path>` повторяемый: можно перечислить несколько плагинов,
передав флаг несколько раз. EXE запускает Steam под CDP, загружает
фреймворк + ваш бандл, прокидывает его в Main shell и вызывает
`init(ctx)`.

Через 5–10 секунд после старта Steam'а в шапке появится ваша кнопка
«Привет». Клик пишет строку `button clicked` в spdlog injector'а
(stdout/console.log + файл-лог в `%LOCALAPPDATA%\steambooster\logs\`).

> **Если кнопка не появилась.** Чек-лист:
>
> - В логе injector'а есть строка `plugin registered: my-plugin`?
> - Нет ли там `apiVersion mismatch`, `cross-validation skip`,
>   `capability not granted`? Совпадает ли `id` в коде с именем файла
>   бандла?
> - В логе injector'а нет ошибок запуска Steam? `steambooster-dev.exe` сам
>   стартует Steam с `-cef-enable-debugging`; если CDP-порт так и не
>   открылся, injector логирует ожидание порта.
>
> Полный разбор частых проблем —
> [`./troubleshooting.md`](./troubleshooting.md).

## Step 7 — что дальше

Минимальный плагин работает. Дальше — типовые расширения.

### Сохранять состояние через `sb.configs`

```ts
import {
  ContextKind,
  Capability,
  type PluginContext,
} from '@steambalance/booster-framework';

declare const sb: {
  plugins: { register: (m: unknown) => void };
};

interface MyConfig {
  readonly greeting: string;
}

sb.plugins.register({
  id: 'my-plugin',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Мой плагин',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui, Capability.Configs, Capability.Bus],
  async init(ctx: PluginContext): Promise<() => void> {
    const saved = await ctx.configs.read<MyConfig>('settings');
    const greeting = saved?.greeting ?? 'Привет';

    const button = ctx.sb.ui.addHeaderButton({
      id: 'btn',
      label: greeting,
      onClick: async () => {
        await ctx.configs.write<MyConfig>('settings', { greeting: 'Снова привет' });
        ctx.sb.bus.publish('my-plugin.clicked', { at: Date.now() });
      },
    });

    const id = ctx.scope.setInterval(() => ctx.log.debug('still alive'), 60_000);

    return () => {
      ctx.scope.clearInterval(id);
      button.remove();
    };
  },
});
```

Что здесь нового:

- **`ctx.configs.read<T>` / `write<T>`** — per-plugin namespace,
  шифрование libsodium (XChaCha20-Poly1305), квота 4 МБ. Полная
  reference — [`./configs-api.md`](./configs-api.md).
- **`ctx.sb.bus.publish(topic, data)`** — broadcast в другие
  injected-таргеты. Topic'и обязаны начинаться с `<pluginId>.`; см.
  [`./bus-api.md`](./bus-api.md).
- **`ctx.scope.setInterval`** — таймер автоматически снимется на
  rollback (выход плагина, hot-reload). Аналогично для `setTimeout`,
  `fetch`, `listen`, `observer`. См. [`./scope-api.md`](./scope-api.md).

### Тестирование

`@steambalance/booster-framework/testing` экспортирует `createTestPluginContext`
с in-memory fakes для всех sub-API'ев. Запуск init'а вне Steam,
проверка bus-публикаций, configs-чтений, DOM-мутаций. См.
[`./testing.md`](./testing.md).

### Publish

Когда плагин готов к production:

1. Поднять `version` в `package.json` до `0.1.0`.
2. `SB_PRODUCTION=1 bun run build` — минифицированный бандл.
3. Загрузить артефакт на свой CDN (или прислать его оператору
   `STEAMBALANCE`).
4. Подать заявку на portal'е — оператор подпишет ваш плагин в
   production-manifest'e (Ed25519). После публикации манифеста плагин
   автоматически появится у каждого пользователя через
   bundle-hot-update.

## Следующие шаги

| Файл | Когда читать |
|---|---|
| [`./plugin-contract.md`](./plugin-contract.md) | Полный signature `register`, lifecycle, cross-validation. |
| [`./capabilities.md`](./capabilities.md) | Какие capability'и существуют, формула effective grant. |
| [`./ui-api.md`](./ui-api.md) | `attachPopup`, `openWindow`, `openExternalWindow`. |
| [`./scope-api.md`](./scope-api.md) | Avoid leaks: `scope.*` для всех async-ресурсов. |
| [`./troubleshooting.md`](./troubleshooting.md) | Когда плагин не загрузился — куда смотреть. |
| [`./testing.md`](./testing.md) | Unit-тесты против `createTestPluginContext`. |
