# Troubleshooting

Типичные ошибки при написании плагинов под `@steambalance/booster-framework` и
как их чинить. Перед чтением — убедитесь, что хорошо ориентируетесь
в [`./plugin-contract.md`](./plugin-contract.md) и
[`./capabilities.md`](./capabilities.md).

## Где смотреть логи

```
%LOCALAPPDATA%\steambooster\logs\
├── steambooster.log          ← живой spdlog текущей сессии
└── steambooster_<ts>.log     ← ротированные backups (последние N)
```

`steambooster.log` — append'ится при каждом старте; ротация при превышении
размера. Все сообщения формата `[plugin:<id>] ...` — это `ctx.log.*`
плагина, прошедшие через native bridge.

Кроме файла, в dev-сборке (`steambooster-dev.exe`) spdlog зеркалируется
в stdout — запускайте EXE из PowerShell, чтобы видеть строки live.

Если EXE упал — посмотрите `%LOCALAPPDATA%\steambooster\crashes\`:
там crash-dump'ы (`.dmp` + `.json`).

Поиск тёплых warn'ов в исходниках (для понимания, какой log-line
относится к вашему симптому):

```pwsh
Get-ChildItem ./src/ -Recurse -Filter '*.ts' |
  Select-String -Pattern 'warn|nativeWarn|skip|mismatch' -Context 0,1
```

## Plugin failed to register

### `plugin '<id>' registered but not in manifest — skipping`

**Источник:** `booster-framework/src/plugins/bootstrap.ts:93`.

**Что значит:** ваш бандл вызвал `sb.plugins.register({id})`, но в
manifest (`__SB_PLUGINS_MANIFEST__.plugins[]`) нет entry с этим
`id`. Framework skip'ит — плагин не запустится.

**Чинить:**
- **Production:** убедитесь, что свежий, подписанный manifest содержит
  ваш плагин в `requiredPlugins[]` или `approvedPlugins[]`. Скорее
  всего вы забыли пересобрать manifest после добавления плагина.
- **Dev:** `--dev-plugin=<path>` автоматически добавляет entry в
  effective manifest, но id в bundle и id в файле должны совпадать. Если
  плагин компилируется в `out/foo-0.0.1.js` — внутри `sb.plugins.register`
  должно стоять `id: 'foo'` (не `'booster-plugin-foo'`; не `'my-foo'`).
  EXE сравнивает строго.

### `plugin entry: invalid id '<id>'`

**Источник:** валидация манифеста в нативном инжекторе —
плагин-id, не соответствующий
`^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$`, отвергается.

**Что значит:** id должен:

- начинаться с lowercase letter;
- содержать только `a-z`, `0-9`, `-`;
- длина 3..40;
- не оканчиваться на `-`.

**Чинить:** переименовать в snake-case с дефисами без подчёркиваний.
`my_plugin`, `MyPlugin`, `1stplugin`, `-foo` — все невалидные. `my-plugin`,
`addfunds`, `booster-checkout` — валидные.

### `requiredPlugins[].id must start with 'booster-': <id>`

**Источник:** валидация манифеста в нативном инжекторе.

**Что значит:** entry попало в `requiredPlugins[]` (vendor-blessed), но
id не начинается с `booster-`. `requiredPlugins[]` зарезервированы для наших
собственных плагинов; сторонние плагины идут в `approvedPlugins[]`.

**Чинить:** либо переместите entry в `approvedPlugins[]`, либо
переименуйте плагин с `booster-` префиксом — но только если вы действительно
один из vendor'ов (`booster-*` префикс — наш namespace).

### `approvedPlugins[].id must NOT start with 'booster-': <id>`

**Источник:** валидация манифеста в нативном инжекторе. Зеркало
предыдущей: сторонним плагинам запрещено сидеть на нашем namespace'е.

**Чинить:** переименовать плагин без `booster-` префикса.

### `plugin entry: invalid version '<ver>'`

**Источник:** валидация манифеста в нативном инжекторе. `version`
должна быть валидным semver'ом (e.g. `0.0.1`, `1.2.3-beta.1`).

**Чинить:** придерживайтесь semver. `0.0.1` — да; `v0.0.1` — нет; `1.0` — нет.

### `plugin entry: invalid sha256 hex`

**Источник:** валидация манифеста в нативном инжекторе. `sha256` field
в manifest entry должна быть 64-символьной hex-строкой.

**Чинить:** пересоберите manifest через `scripts/build-manifest.ts` —
он считает sha256 правильно. Не пишите руками.

### `plugin entry: 'contextKinds' non-empty array required`

**Источник:** валидация манифеста в нативном инжекторе. Либо нет
`contextKinds`, либо он пустой массив.

**Чинить:** в manifest и в `sb.plugins.register` укажите хотя бы один
из: `'main'`, `'shared'`, `'tabbedBrowser'`, `'web'`. Используйте
константу: `contextKinds: [ContextKind.Main]`.

### `plugin entry: invalid contextKind '<kind>'`

**Источник:** валидация манифеста в нативном инжекторе. Незнакомый kind в массиве.

**Чинить:** только `main`, `shared`, `tabbedBrowser`, `web`. Если вы
видите `mainShell` — это устаревшее имя из дофинализационной эпохи;
переименуйте в `main`.

### `plugin entry: 'grantedCapabilities' non-empty array required`

**Источник:** валидация манифеста в нативном инжекторе. Если плагин в
manifest entry указан без `grantedCapabilities` или с пустым массивом — отказ.

**Чинить:** перечислите хотя бы один capability (`ui`, `steam`,
`configs`, `bus`, `pages`, `keys`). Если плагин не требует
никаких — скорее всего ему вообще не нужно быть в manifest'е.

### `plugin entry: unknown capability '<cap>'`

**Источник:** валидация манифеста в нативном инжекторе. Опечатка в capability-имени.

**Чинить:** используйте константу `Capability.Ui` / `Capability.Steam` /
... — TypeScript не даст вам ошибиться.

## Capability denied

### `TypeError: Cannot read properties of undefined (reading 'addHeaderButton')`

**Что значит:** плагин не запросил `Capability.Ui` в `register`'е, либо
manifest entry не выдал. `ctx.sb.ui === undefined`.

**Чинить — два пути:**

1. **Запросить capability**: добавьте `Capability.Ui` в `capabilities`
   массив `register`'а:

   ```ts
   sb.plugins.register({
     id: 'my-plugin', version: '0.0.1', apiVersion: 1,
     displayName: 'My Plugin',
     contextKinds: [ContextKind.Main],
     capabilities: [Capability.Ui],
     init: (ctx) => { ctx.sb.ui.addHeaderButton(...); },
   });
   ```

2. **Гардить optional-chaining'ом**: если capability — optional feature:

   ```ts
   if (ctx.granted.has(Capability.Ui)) {
     ctx.sb.ui.addHeaderButton(...);
   } else {
     ctx.log.warn('Ui not granted — feature disabled');
   }
   ```

Effective grant = `bundle.requested ∩ manifest.granted`. Если у вас
оба указаны, но `ctx.sb.ui` всё равно undefined — проверьте, что
`ctx.granted.has(Capability.Ui) === true`; если нет, ваш manifest
entry не содержит `'ui'` в `grantedCapabilities[]`. Подробности —
[`./capabilities.md`](./capabilities.md).

## `bus.publish: topic must start with '<pluginId>.'`

**Источник:** `booster-framework/src/plugins/bus.ts:18`.

**Что значит:** плагин с id `my-plugin` попытался опубликовать topic
`other.event`. Каждый плагин может публиковать только в свой namespace
(`<pluginId>.*`).

**Чинить:** добавьте префикс с pluginId:

```ts
// Плохо:
ctx.sb.bus.publish('event', { foo: 1 });

// Хорошо:
ctx.sb.bus.publish('my-plugin.event', { foo: 1 });
```

`subscribe` НЕ имеет prefix-ограничения — любой плагин может слушать
любой topic. Подробности — [`./bus-api.md`](./bus-api.md).

## `sb.bus.publish: payload too large (<N> > 16384)`

**Источник:** `booster-framework/src/api/bus.ts:80`.

**Что значит:** UTF-8 byte-length payload'а после `JSON.stringify`
превысил 16 KB.

**Чинить:**
- разбейте payload на несколько событий;
- передавайте только дельту, не полный state;
- если действительно нужен большой blob — храните в `configs.write`
  и шлите по bus только ключ (`{ configKey: 'foo' }`).

## `sb.bus.publish: data not JSON-serializable: ...`

**Источник:** `bus.ts:73`.

**Что значит:** `data` содержит `Function`, `Symbol`, `BigInt` (без
custom toJSON) или циклические ссылки.

**Чинить:** пересоберите payload только из примитивов / plain object /
arrays. `Date` приемлем — он сериализуется через `toJSON`.

## UI

### `ui: invalid id '<id>' (must match /^[a-zA-Z0-9_-]{1,64}$/)`

**Источник:** `booster-framework/src/plugins/ui.ts:13`. Sync throw на любом
`addHeaderButton` / `attachPopup` / `openWindow` / `openExternalWindow`
с невалидным `id`.

**Чинить:** id для UI элемента — только `[a-zA-Z0-9_-]`, длина 1..64.
Пробелы / точки / кириллица — невалидны. Не путать с topic'ами bus'а
(там нижний регистр + `.` разрешён).

### Popup not appearing

**Симптом:** `await sb.ui.attachPopup(...)` вернул handle, но `popup.show()`
ничего не делает.

**Чинить:**

1. **Verify, что handle живой:**
   ```ts
   const popup = await ctx.sb.ui.attachPopup({ id: 'p', html: '...', width: 300 });
   ctx.log.info('popup created', { width: popup.width, height: popup.height });
   ```
   Если log не появился — `attachPopup` rejected (исключение раньше).

2. **`show()` требует координаты:** `popup.show({ x, y })` — не
   `popup.show()` без аргументов. Sync throw на неверной сигнатуре.

3. **Toggle-rate-limit:** Two consecutive `toggle({ x, y })` ближе 250мс
   друг к другу — второй consum'ится без эффекта. Используйте `show()` /
   `hide()` raw, если надо bypass'ить gate.

4. **`hideOnBlur: true` (default):** если клик через popup попадает на
   что-то снаружи — popup закрывается. Передайте `hideOnBlur: false`
   если popup должен оставаться открытым программно.

5. **Steam iframe-blocking:** в редких случаях Steam сам форсит close
   popup'а при scroll'е main shell'а. Логируйте `popup.on('hide', ...)`
   чтобы увидеть, кто закрывает.

Подробности — [`./ui-api.md`](./ui-api.md).

### `attachPopup: invalid id "..."` или `attachPopup: invalid width`

**Источник:** `booster-framework/src/api/ui.ts:365-371`. Width должен быть
positive integer; id — `[a-zA-Z0-9_-]{1,64}`.

### `openExternalWindow: only https:// allowed` / `userinfo not allowed` / `non-ASCII characters not allowed`

**Источник:** `booster-framework/src/api/external-window.ts:92-97`.

**Чинить:** URL должен быть `https://`, ASCII-only, без `user:pass@`,
без explicit port. Cyrillic в pathname — невалидно; используйте
percent-encoding (`%D0%9F...`) или передавайте только ASCII.

## Configs

### `configs.read` returns `null`

**Это НЕ ошибка.** `null` — нормальный возврат при:

- ключа никогда не было (first-call cold path);
- файл существует, но был повреждён (decrypt/parse failure);
- невалидное имя ключа;
- ошибка дешифровки libsodium (XChaCha20-Poly1305 secretbox).

Native side логирует `[configs:<id>] read: <reason>` через warn-канал —
смотрите spdlog, если хотите узнать почему именно `null`.

**Чинить:** не относитесь к `null` как к ошибке. Используйте default:

```ts
const settings = await ctx.configs.read<MyConfig>('settings') ?? defaultSettings;
```

### `configs.write` rejects with `invalid name`

**Что значит:** name должно быть filename-safe: `[a-zA-Z0-9_-]{1,32}`,
никаких `/`, `\`, `..`. Иначе native side reject'ит.

**Чинить:** переименуйте ключ.

### `configs.write` rejects with `quota exceeded` / disk full

**Что значит:** per-plugin квота — 4 MB, distributed across all
configs одного плагина. Либо плагин разросся, либо диск полон.

**Чинить:** удалите unused-конфиги или сократите payload. См.
[`./configs-api.md`](./configs-api.md).

## Lifecycle / rollback

### `plugin '<id>' apiVersion <N> not supported`

**Источник:** `bootstrap.ts:105`.

**Что значит:** ваш `apiVersion: N` в bundle не входит в
`SUPPORTED_API_VERSIONS = new Set([1])`. Скорее всего вы поставили
`apiVersion: 2` (или 0) «на будущее».

**Чинить:** `apiVersion: 1` — единственно поддерживаемая на сегодня
константа `CURRENT_API_VERSION`.

### `plugin '<id>' cross-validation failed: <reason>`

**Источник:** `bootstrap.ts:110`. Сравнение bundle's `register` метаданных
с manifest entry. Возможные reasons:

| Reason                            | Причина                            |
|-----------------------------------|-------------------------------------|
| `id mismatch: ...`                | id в bundle ≠ id в manifest entry  |
| `version mismatch: ...`           | version в bundle ≠ version в manifest |
| `api version mismatch: ...`       | apiVersion в bundle ≠ apiVersion в manifest |
| `contextKind '<k>' not granted`   | bundle requests Web, manifest only allows Main |
| `urlPattern '<p>' not in manifest`| bundle's urlPattern не в manifest's allowed list |

**Чинить:** синхронизируйте bundle's `register({...})` с manifest entry.
Поле-в-поле. Manifest — source of truth; bundle ≤ manifest.

### `plugin '<id>' urlPattern '<p>' is not a valid regex`

**Источник:** `bootstrap.ts:123`.

**Что значит:** urlPattern manifest'а не компилится в JS-стороне
`new RegExp(pattern)`. Нативный инжектор проверяет regex заранее,
так что эта строка означает либо мини-разногласие двух regex-engine'ов
(POSIX vs ECMAScript), либо commit-time fluke.

**Чинить:** упростите regex. Прокинте его через `new RegExp(...)` в
unit-тесте перед добавлением в manifest.

### `__SB_PLUGINS_MANIFEST__ missing — plugins disabled this session`

**Источник:** `bootstrap.ts:176`.

**Что значит:** injection-prefix нативного инжектора не добавил
`__SB_PLUGINS_MANIFEST__` к bundle'у. Это сигнализирует либо
bootstrap-bug в инжекторе, либо ручной запуск framework'а без инжектора.

**Чинить:** Перезапустите EXE. Если повторяется — соберите логи и
заведите issue.

### Plugin shows in dev but not in production

**Симптом:** `--dev-plugin=` работает, но после signed release плагин
не загружается.

**Чинить — чек-лист:**

1. **Signed manifest содержит вашу entry?** Откройте production manifest
   на CDN (или локально через `serve-static.ts`), убедитесь что в
   `requiredPlugins[]` / `approvedPlugins[]` есть entry с правильным id.

2. **sha256 совпадает?** Manifest содержит sha256 от bundle-файла. После
   изменения bundle нужно пересчитать sha256 и обновить manifest. Если
   нет — `framework sha256 mismatch` или `plugin '<id>' sha256 mismatch`
   в логе.

3. **Bundle URL правильный?** Manifest entry содержит абсолютный URL
   bundle'а. Если CDN изменился — обновите.

4. **manifest подписан свежим ключом?** Production verify в нативном
   инжекторе с production-pubkey. Старый dev-ключ → отказ:
   `signature length != 64` или silently-skip с `signature verify failed`.

5. **`disabled: true`?** Manifest top-level field `disabled` — kill-switch.
   Если true — все плагины skip'ятся.

6. **EXE rolled back?** Self-update fail → boot-2nd-fail → rollback к
   previous EXE → previous EXE может не знать о новом плагине. Смотрите
   `[self-update]` в spdlog.

## Hot-reload (dev)

### Hot-reload не подхватывает изменения

**Симптом:** изменили `src/index.ts`, пересобрали bundle, но в Steam'е
ничего не изменилось.

**Чек-лист:**

1. **`bun --watch` запущен?** Проверьте, что отдельный терминал крутит
   `bun build --watch src/index.ts --outdir=out`. Если bundle не
   пересобирается — EXE и не подхватит.

2. **`bundle_watcher` запущен?** Dev EXE мониторит `out/` через
   `bundle_watcher` (только `!SB_PRODUCTION`). Если EXE собран как
   production — watcher disabled, нужно `steambooster-dev.exe`.

3. **Off-default путь к фреймворку/плагинам (`SB_FRAMEWORK_PATH` /
   `SB_PLUGINS_PATH` env var):** если фреймворк или плагины лежат не по
   умолчанию и dev-оркестратор инжектора резолвит
   `process.env.SB_FRAMEWORK_PATH` — проверьте, что env var указывает на
   правильный каталог. См.
   [`./getting-started.md`](./getting-started.md).

4. **Скорость**: bundle_watcher debounce'ит ~200мс. Если сохраняете
   часто — последний событие выигрывает; intermediate'ы skip'ятся. Это
   ожидаемое поведение.

5. **Steam перестал слушать CDP:** при hot-reload framework'а Steam
   page может умереть (пустой `chrome://inspect`). Вмешиваться не нужно:
   `ProcessWatcher` детектит смерть Steam, а инжектор сам
   перезапускает его с флагами отладки (`DoKillAndRestart`,
   `with_debug=true`) и переинъектируется.

### EXE не attaches к Steam

**Симптом:** `steambooster-dev.exe` стартанул, но `plugin '<id>' init`
не пишется в лог.

**Чек-лист:**

1. **CDP-порт не открылся?** Инжектор сам запускает (или
   перезапускает) Steam с флагами `-cef-enable-debugging
   -devtools-port=<N>` — вручную флаг передавать не нужно. Если в логе
   висит `waiting for CDP port`, значит Steam стартовал, но порт
   отладки так и не поднялся: проверьте, что у EXE есть права поднять
   Steam, и что путь к `steam.exe` в реестре
   (`HKCU\Software\Valve\Steam\SteamExe`) корректен. См.
   [`./getting-started.md`](./getting-started.md).

2. **CDP-порт занят (dev only)?** Dev EXE пинит порт 8080. Если кто-то
   ещё (другой `steambooster-dev.exe`, или Millennium, или плагин стороннего
   автора) уже занял 8080 — steambooster уходит в `PortConflict`. Лог:
   `cdp port 8080 squatted by pid <N>`. Чинить — Task Manager → kill
   процесс на 8080, перезапустить.

3. **Production-CDP-порт:** в production EXE — random loopback port, не
   8080. Если вы пишете ad-hoc tooling — берите live порт из логов
   (`cdp_port=<N>`), не предполагайте 8080.

4. **Killswitch in manifest:** `disabled: true` top-level в manifest →
   EXE стартует, но bootstrap skip'ает framework injection. Лог:
   `manifest disabled — skipping injection`. Чинить — переподписать
   manifest с `disabled: false` или fetch'нуть свежий.

5. **Killswitch при rollback:** два подряд boot-fail'а EXE → auto-rollback
   к previous good. После rollback'а текущий manifest может относиться
   к более новому EXE → `manifest schema: schemaVersion must be 2`
   или подобный mismatch. Чинить — обновить EXE через `--update`.

## See also

- [`./getting-started.md`](./getting-started.md) — первая настройка dev
  workflow.
- [`./plugin-contract.md`](./plugin-contract.md) — поля manifest entry,
  cross-validation.
- [`./capabilities.md`](./capabilities.md) — effective grant, capability
  gating.
- [`./lifecycle.md`](./lifecycle.md) — init/cleanup timeouts, rollback.
- [`./testing.md`](./testing.md) — как воспроизводить проблемы в
  unit-тесте, не подключая Steam.
- Валидация манифеста в нативном инжекторе — все validation errors,
  которые видит native side.
- `booster-framework/src/plugins/bootstrap.ts` — все skip-warn'ы, которые
  видит framework side.
