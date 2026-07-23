# Plugin Contract

`PluginManifest` — то, что плагин передаёт в `sb.plugins.register({...})`.
Этот документ описывает каждое поле, правила cross-валидации против
подписанного манифеста и порядок lifecycle-вызовов.

> Исходный источник истины — `booster-framework/src/api/api-types.ts`
> (interface `PluginManifest`, `PluginContext`, `InitResult`). При
> расхождении документация догоняет код, не наоборот.

## Сигнатура `sb.plugins.register`

```ts
interface PluginsApi {
  register(opts: PluginManifest): void;
  ready(): Promise<void>;
}
```

`register` — синхронный. Валидация идёт в два этапа, каждый со своими
сообщениями ошибок:

- **Shape-валидация** (`validateShape` в `booster-framework/src/api/plugins.ts`)
  бросает на отсутствующих / неверных по типу обязательных полях: например
  `register: invalid id '<id>'`, `register: version required`,
  `register: displayName required`, `register: contextKinds must be
  non-empty array`. TS не пропустил бы такой вызов, но проверка всё равно
  идёт в рантайме, потому что бандл — IIFE без типов.
- **Регистрация** (`PluginRegistry.add` в
  `booster-framework/src/plugins/registry.ts`) бросает `plugin '<id>' already
  registered` при повторном `register` с тем же id в пределах одного
  eval'а. Между re-injection'ами `PluginRegistry` создаётся заново, поэтому
  повторная регистрация тех же id в новом бандл-eval'е — норма, а не ошибка.

`register` НЕ запускает `init` немедленно. Регистрация просто кладёт
`PluginManifest` в `PluginRegistry`. Framework вызывает `init(ctx)` после
того, как:

1. lifecycle.ready() resolved (фреймворк прошёл свой bootstrap);
2. нативный инжектор положил в `window.__SB_PLUGINS_MANIFEST__` подписанную
   manifest-запись;
3. cross-validation между bundle-side `PluginManifest` и manifest-entry
   прошла (см. ниже).

## `PluginManifest` field reference

```ts
interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly displayName: string;
  readonly description?: string;
  readonly contextKinds: ContextKind[];
  readonly urlPatterns?: string[];
  readonly capabilities: Capability[];
  readonly init: (ctx: PluginContext) => InitResult | Promise<InitResult>;
}
```

### `id: string` (REQUIRED)

Regex: `^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$` (см.
`PluginManifest.id` JSDoc в `api-types.ts`).

- 3..40 символов; lower-case; начинается с буквы; может содержать дефис
  внутри, но не подряд и не на границе.
- Глобально уникален среди установленных плагинов: дубликат `id` в одном
  бандл-eval'е — sync throw `plugin '<id>' already registered`.

**Префикс `booster-` зарезервирован.** Injector-side ManifestLoader
форсирует две инварианты подписанного манифеста:

- `requiredPlugins[].id` обязан начинаться с `booster-` (внутренние плагины
  от STEAMBALANCE);
- `approvedPlugins[].id` НЕ должен начинаться с `booster-` (сторонние
  плагины).

Сторонние плагины должны выбирать другой префикс (например имя бренда:
`acme-foo`). Регистрация плагина с id `booster-foo` через `approvedPlugins[]`
будет отвергнута на стороне инжектора при загрузке манифеста.

### `version: string` (REQUIRED)

Semver `MAJOR.MINOR.PATCH`. Должен совпадать с `version` в manifest-entry
ровно byte-for-byte — `crossValidate` сравнивает по `===`, без semver-range
семантики. Версия бандла на CDN'е сшита с версией в подписанном манифесте.

### `apiVersion: number` (REQUIRED)

Дискретное целое. Должно быть в `SUPPORTED_API_VERSIONS` фреймворка. На
момент написания:

```ts
export const CURRENT_API_VERSION = 1;
export const SUPPORTED_API_VERSIONS: ReadonlySet<number> = new Set([1]);
```

Если плагин заявляет `apiVersion: 2`, а фреймворк знает только `[1]` —
плагин пропускается с warn-логом `plugin '<id>' apiVersion 2 not
supported`. Остальные плагины продолжают работать (failure isolation).

### `displayName: string` (REQUIRED)

Human-readable имя. **Required, не optional** — поле без `?` в интерфейсе
`PluginManifest` (`api-types.ts`). Используется:

- в логах фреймворка (`[plugin:<id>]` prefix + displayName в meta);
- в tray-меню (управление включением/выключением плагинов);
- в потенциальном admin-UI.

Стиль — sentence case на языке пользователя; для RU-only дистрибутива
это русский: `"Пополнение баланса"`, `"Часы игры"`.

### `description?: string` (optional)

Более длинное описание (1–2 предложения). Опционально; если нет —
пустая строка в логах. Тот же стиль / язык, что `displayName`.

### `contextKinds: ContextKind[]` (REQUIRED)

В каких Steam V8-контекстах плагин запускается:

```ts
export const ContextKind = {
  Main:           'main',
  Shared:         'shared',
  TabbedBrowser:  'tabbedBrowser',
  Web:            'web',
} as const;
```

- **`Main`** — главное окно Steam (header, library, store-tab внутри
  главного окна).
- **`Shared`** — SharedJSContext: глобальный SDK Steam (доступ к
  `SteamClient.*`). UI не доступен — DOM нет.
- **`TabbedBrowser`** — отдельные tabbed-окна (News, Payment).
- **`Web`** — embedded-страницы Steam (store, community, help) — DOM
  есть, но CSP жёстче.

`init(ctx)` вызывается один раз на каждый `ContextKind`, где плагин
заявлен И где фреймворк инжектирован в этой сессии.

Cross-validation: `bundle.contextKinds` MUST быть подмножеством
manifest-entry `contextKinds`. Если бандл хочет `[Main, Web]`, а в
подписанном манифесте только `[Main]` — `crossValidate` отвергает с
`contextKind 'web' not granted by manifest`.

> **Импортируйте `ContextKind.Main`, не литерал `'main'`.** Опечатка
> уйдёт в cross-validation skip с warn-логом, плагин просто не запустится
> и причина не очевидна.

### `urlPatterns?: string[]` (optional)

Regex-source строки. Если задан, плагин в context'е (где есть URL —
`Main`, `Web`, `TabbedBrowser`) запускается ТОЛЬКО когда
`new RegExp(p).test(currentUrl)` для хотя бы одного `p`. В `Shared`
поле игнорируется (нет URL).

Cross-validation: bundle.urlPatterns MUST быть подмножество (string
equality) manifest-entry urlPatterns. Manifest владеет белым списком,
бандл может сузить — расширить не может.

Пример: плагин-checkout фильтруется до checkout-страниц:

```ts
urlPatterns: ['^https://store\\.steampowered\\.com/checkout/'],
```

### `capabilities: Capability[]` (REQUIRED)

```ts
export const Capability = {
  Ui:       'ui',
  Steam:    'steam',
  Configs:  'configs',
  Bus:      'bus',
  Pages:    'pages',
  Keys:     'keys',
  Net:      'net',
} as const;
```

Effective capability set = `bundle.capabilities ∩
manifestEntry.grantedCapabilities`. Если плагин просит `[Ui, Configs]`, а
manifest даёт `[Ui]` — effective `{Ui}`, и `ctx.sb.configs === undefined`.

Доступны и сторонним (`approvedPlugins[]`), и внутренним
(`requiredPlugins[]`) плагинам: `Ui`, `Steam`, `Configs`, `Bus`, `Pages`,
`Keys`, `Net`. Никакого автоматически выдаваемого набора нет — capability
действует, только если она перечислена в `grantedCapabilities`
manifest-записи плагина.

`Capability.Steam` открывает весь `ctx.sb.steam`:
`openUrl`, `getCurrentUser`, `getCurrentUserAsync`, `onUserChange`,
`getStoreCountry(): Promise<string | undefined>` — страна магазина аккаунта
(ISO 3166-1 alpha-2, напр. `'KZ'`; `undefined` до первого захвата или после
смены аккаунта; никогда не throw),
`getStoreCurrency(): Promise<string | undefined>` — валюта кошелька (ISO 4217,
напр. `'USD'`). Каскад: валюта из строки баланса → фолбэк по стране магазина
(нулевые кошельки USD-региона отдают пустой баланс); читает актуальный кэш при
каждом вызове; `undefined` вне RU-региона при пустом балансе; никогда не throw'ит,
`getMachineId(): Promise<MachineId | undefined>` — hardware-derived SHA1 triple
`{bb3, ff2, b3b}` от Steam's `Auth.GetMachineID()`; `undefined` при недоступности;
никогда не throw; значения не логируются. Подробнее —
[`./steam-api.md`](./steam-api.md#getmachineid-promisemachineid--undefined),
`getOwnedGames(options?): Promise<OwnedGamesResult>` — owned-game library из
`collectionStore`, опционально обогащённый ценами из `StoreItemCache`; ban-safe,
никогда не throw; `ready: false` если collectionStore ещё не был заполнен.
Игры, взятые по семейному доступу (Family Sharing), **исключаются** — их
количество отдаётся в `familySharedExcluded`. Подробнее —
[`./steam-api.md`](./steam-api.md#getownedgamesoptions-promiseownedgamesresult),
`getInventory(options?): Promise<InventoryResult>` — собственный инвентарь
пользователя (предметы + market hash names) через аутентифицированный CM
(`Econ.GetInventoryItemsWithDescriptions`); полный даже при скрытом публичном
инвентаре; ban-safe; никогда не throw; `partial: true` при сбое или усечении
какого-либо app. Подробнее —
[`./steam-api.md`](./steam-api.md#getinventoryoptions-promiseinventoryresult),
`getAccountLevel(): Promise<number | undefined>` — уровень аккаунта Steam
(XP/badge level). Добывается relay-side: сначала через CM
(`Player.GetGameBadgeLevels`), затем miniprofile-fallback; никогда не throw;
`undefined` при недоступности. Подробнее —
[`./steam-api.md`](./steam-api.md#getaccountlevel-promisenumber--undefined),
`getParentalState(): Promise<ParentalState | undefined>` — состояние семейного
просмотра Steam (Family View). `{everEnabled, locked}`; `locked: true` означает,
что библиотека и инвентарь закрыты PIN-кодом и любые прочитанные из них данные
недостоверны (как правило — пусты). `undefined` = состояние определить не
удалось; это **не** «разблокировано». Никогда не throw.

`getAvatarDataUrl(): Promise<string | null>` — аватар текущего пользователя как
маленький JPEG data-URI (даунскейл ~128px), перекодированный relay-side из
локального кэша аватаров; готов к прямому показу в `<img>`. `null` при
недоступности; никогда не throw. Публичный CDN-URL аватара клиент надёжно не
отдаёт (нет avatar-хэша), а loopback-путь недоступен из content-браузера —
поэтому картинка пакуется в data-URI. Подробнее —
[`./steam-api.md`](./steam-api.md#getavatardataurl-promisestring--null).

`Capability.Ui` открывает `ctx.sb.ui`: `addHeaderButton`, `attachPopup`,
`openWindow`, `openExternalWindow`, `addMenuItem` (пункт в верхней навигации
Steam — МАГАЗИН / БИБЛИОТЕКА / …, с навигацией главного окна по клику),
`addStoreNavButton` (кнопка в верхнем таб-баре страницы магазина Steam —
«Просмотр / Рекомендации / Категории / …»; только `Web`-контекст; опции
`id, label, icon?, url, variant?, placement?`; переживает React re-renders
и пересборки Steam через структурный якорь + reconcile; throws on invalid
id, label, icon, or url),
`addSuperNavButton` (кнопка в супернаве Steam-клиента — «Магазин /
Библиотека / Сообщество / `<НИК>`», после таба `<НИК>`; только
`Main`-контекст; onClick-only + loading/error-состояния; якорится по
persona/account-имени из `user-snapshot` и переживает пересборки Steam и
смену аккаунта; throws on invalid id, label, or icon).
Полный справочник — [`./ui-api.md`](./ui-api.md).

Плагин, которому нужна активация продуктовых ключей Steam, объявляет
`Capability.Keys` в своём `register` вызове:

```ts
sb.plugins.register({
  id: 'my-key-plugin',
  // ...
  capabilities: [Capability.Keys],
  async init(ctx) {
    if (!ctx.granted.has(Capability.Keys)) return;
    const res = await ctx.sb.keys.activate(key);
    // ...
  },
});
```

Manifest-entry должен включать `'keys'` в `grantedCapabilities`. Без
этого `ctx.sb.keys === undefined`. Подробнее об API и контракте
non-idempotency — [`./steam-api.md`](./steam-api.md#keys-api).

Плагин, которому нужен нативно-проксируемый fetch, объявляет
`Capability.Net` в своём `register` вызове:

```ts
sb.plugins.register({
  id: 'my-net-plugin',
  // ...
  capabilities: [Capability.Net],
  async init(ctx) {
    if (!ctx.granted.has(Capability.Net)) return;
    const r = await ctx.sb.net.fetch('https://steambalance.cc/api/x');
    // ...
  },
});
```

Manifest-entry должен включать `'net'` в `grantedCapabilities` И
`allowedHosts: string[]` с каждым хостом, который плагин собирается
запрашивать через `sb.net.fetch`. Канонический формат хоста —
lowercase, ASCII, без схемы/порта/пути/userinfo/glob (см. `ALLOWED_HOST_RE`
в `booster-framework/src/testing/plugin-meta.ts`). Без `allowedHosts` с
нужным хостом нативный `net_fetch` op отклонит запрос. Подробнее —
[`./net-api.md`](./net-api.md).

### `init: (ctx) => InitResult | Promise<InitResult>` (REQUIRED)

Главная функция плагина. Подробно — [`./lifecycle.md`](./lifecycle.md).

```ts
export type InitResult = void | (() => void | Promise<void>);
```

- Можно вернуть синхронную или асинхронную cleanup-функцию.
- Можно вернуть `undefined` — но тогда нет cleanup-хука, и плагин
  полагается ТОЛЬКО на `ctx.scope.*` для деаллокации (которая снимется
  на rollback автоматически).
- Init timeout — 30 секунд. Если `init` не зарезолвился — плагин
  считается зависшим, cleanup из возвращаемого значения дропается
  (но DOM mutations через `sb.ui.*` всё равно откатятся через framework
  registry на `rollbackAll`).
- Любая ошибка / reject в `init` — изолирована: остальные плагины
  продолжают init.

## `PluginContext` field reference

```ts
interface PluginContext {
  readonly pluginId: string;
  readonly contextKind: ContextKind;
  readonly apiVersion: number;
  readonly granted: ReadonlySet<Capability>;
  readonly sb: SbApi;
  readonly scope: ScopeApi;
  readonly configs: ConfigsApi;
  readonly log: LogApi;
  readonly signal: AbortSignal;
}
```

- **`pluginId`** — дубль `manifest.id` для удобства логов.
- **`contextKind`** — какой именно kind вызвал текущий `init` (важно
  если плагин заявлен в нескольких).
- **`apiVersion`** — эффективная версия API, согласованная с фреймворком.
- **`granted`** — фактически выданные capabilities. `ctx.granted.has(...)` —
  единственный надёжный способ узнать, доступен ли API.
- **`sb`** — capability-gated копия `window.sb`. Gated поля (`ui`,
  `steam`, `configs`, `bus`, `pages`, `keys`) либо ссылаются на
  реальные API, либо `undefined`. Negated-поля **читаются** как
  `undefined` — обращение через optional-chaining не падает.
  Безусловно доступны: `version`, `state`, `context`, `lifecycle`,
  `scope`, `plugins`, `app`.
  `sb.app.getSetupId()` возвращает UUID постоянного install-токена
  инжектора, или `undefined` при недоступности; никогда не throw.
  Подробнее — [`./app-api.md`](./app-api.md).
- **`scope`** — per-plugin scope (own AbortController). Все
  `ctx.scope.*` ресурсы снимутся:
  1. при возврате cleanup-fn из init и его вызове на rollback;
  2. на framework `rollbackAll` независимо от cleanup-fn;
  3. при hot-reload бандла (dev only).
  См. [`./scope-api.md`](./scope-api.md).
- **`configs`** — per-plugin namespace `configs/<plugin-id>/<name>.bin`.
  Доступно только если `Capability.Configs` в `granted`. См.
  [`./configs-api.md`](./configs-api.md).
- **`log`** — структурированный логгер с префиксом `[plugin:<id>]`.
  Pipe через bridge → C++ spdlog. PII redaction — обязанность автора
  (`accountName`, `steamId`, `email`, raw tokens НЕЛЬЗЯ логировать).
- **`signal`** — alias на `ctx.scope.signal`. Удобно когда нужно
  передать в `fetch`, `addEventListener`, `EventSource`.

## Cross-validation rules

Происходит ДО вызова `init`. Источник истины — `crossValidate` в
`booster-framework/src/plugins/validation.ts`.

| Поле               | Правило                                            | Reject сообщение                                  |
|--------------------|----------------------------------------------------|---------------------------------------------------|
| `id`               | `bundle.id === manifest.id`                        | `id mismatch: bundle '<x>' vs manifest '<y>'`     |
| `version`          | `bundle.version === manifest.version`              | `version mismatch: bundle '<x>' vs manifest '<y>'`|
| `apiVersion`       | `bundle.apiVersion === manifest.apiVersion`        | `api version mismatch: bundle <x> vs manifest <y>`|
| `contextKinds`     | bundle ⊆ manifest                                  | `contextKind '<k>' not granted by manifest`       |
| `urlPatterns`      | bundle ⊆ manifest (string equality)                | `urlPattern '<p>' not in manifest`                |
| `capabilities`     | пересекаются runtime — НЕ reject'ит               | (silent — gated через `ctx.sb.<cap>` === undefined) |

Дополнительные skip-условия (не reject — просто плагин не запускается в
текущей сессии):

- Плагин зарегистрирован, но отсутствует в manifest-entry → warn
  `plugin '<id>' registered but not in manifest — skipping`.
- Плагин в `userDisabledPlugins` И не `required` → info skip.
- `bundle.contextKinds` не включает текущий kind → silent skip.
- `apiVersion` не в `SUPPORTED_API_VERSIONS` → warn skip.
- `urlPatterns` не матчат текущий URL → silent skip.

## Bus subscribe ACL (`subscribeTopics`)

Плагин с `Capability.Bus` может вызвать `ctx.sb.bus.subscribe(topic, cb)`:

- **Свой prefix** (`<pluginId>.<anything>`) разрешён всегда.
- **Чужие топики** — только если перечислены в поле `subscribeTopics`
  подписанной manifest-записи этого плагина. Нарушение → синхронный throw
  (аналогично `bus.publish` на чужой prefix).

> **Доставка (local-echo).** `bus.publish` доставляет и подписчикам в
> **том же контексте/сессии** (на микротаске), помимо остальных таргетов —
> нативный fanout пропускает сессию-отправителя, поэтому два co-located
> подписчика (напр. оба в Main) иначе не услышали бы друг друга. Подробнее —
> `docs/bus-api.md`.

`subscribeTopics` — необязательное поле в manifest-записи; по умолчанию
`[]`. Каждый элемент — либо точный топик, либо глоб `prefix.*`:

| Запись в `subscribeTopics` | Что матчится                           |
|----------------------------|----------------------------------------|
| `"other-plugin.event"`     | только `"other-plugin.event"` (точное) |
| `"other-plugin.*"`         | `"other-plugin"` и `"other-plugin.<x>"` |

Для внутренних плагинов (`requiredPlugins[]`) поле задаётся в
`packages/<id>/src/plugin-meta.ts` → `subscribeTopics: [...]` и
проходит через pipeline в signed manifest автоматически.

Сторонние плагины (`approvedPlugins[]`) передают `subscribeTopics` через
`just approve-plugin add --subscribe-topics <comma-separated>`.

Пример: плагин `booster-checkout` подписывается на топики addfunds:

```ts
// plugin-meta.ts
export const pluginMeta: PluginMeta = {
  id: 'booster-checkout',
  // ...
  subscribeTopics: [
    'booster-addfunds.topup-requested',
    'booster-addfunds.user.snapshot.request',
  ],
};
```

## Net allowedHosts ACL (`allowedHosts`)

Плагин с `Capability.Net` может вызвать `ctx.sb.net.fetch(url, init)`
ТОЛЬКО против хостов, перечисленных в поле `allowedHosts` подписанной
manifest-записи этого плагина — нет собственного prefix-исключения
(в отличие от `subscribeTopics`), потому что у плагина нет "своих" хостов
по умолчанию.

`allowedHosts` — необязательное поле в manifest-записи; по умолчанию `[]`
(плагины без `Capability.Net` его не указывают). Каждый элемент —
канонический hostname: lowercase, ASCII, без схемы/порта/пути/userinfo/glob.

Для внутренних плагинов (`requiredPlugins[]`) поле задаётся в
`packages/<id>/src/plugin-meta.ts` → `allowedHosts: [...]` и проходит
через `ManifestPluginEntry.allowedHosts` (тот же путь threading'а, что
`subscribeTopics`) в signed manifest. Инжектор-side CLI (`approve-plugin`)
и pipeline-эмиттер для `allowedHosts` — предмет отдельного плана
(native-op + manifest-pipeline изменения); в этом репозитории описан
только framework-side тип + валидация.

Пример:

```ts
// plugin-meta.ts
export const pluginMeta: PluginMeta = {
  id: 'booster-checkout',
  // ...
  allowedHosts: ['steambalance.cc'],
};
```

## Lifecycle sequence

```
[1] Bundle eval               // IIFE runs in V8 context, calls sb.plugins.register(...)
[2] sb.plugins.register        // PluginRegistry.add(bundle)
[3] lifecycle.ready             // framework finished its own bootstrap
[4] drainPluginsOnReady          // soft-wait for late registrations (≤1s)
[5] filterEligiblePlugins         // userDisabled / contextKind / apiVersion / urlPatterns
[6] crossValidate                  // see table above
[7] makeContext(plugin)             // build capability-gated sb + per-plugin scope/configs/log
[8] init(ctx) → InitResult           // ≤30s timeout; isolated try/catch
[9] outcomes stashed на _pluginOutcomes
[10] ... live session ...
[11] rollbackAll                       // runPluginCleanups (LIFO, ≤5s per cleanup) + scope._abort
```

Hot-reload (dev only) сводится к `rollbackAll` + повторный bundle eval
из шага [1]. Persistent state живёт ТОЛЬКО в `configs.read/write`
(зашифрованный per-plugin namespace).

## Канонический полный пример

```ts
import {
  ContextKind,
  Capability,
  type PluginContext,
  type InitResult,
} from '@steambalance/booster-framework';

declare const sb: {
  plugins: { register: (m: unknown) => void };
};

sb.plugins.register({
  id: 'balance-watcher',
  version: '0.1.0',
  apiVersion: 1,
  displayName: 'Часы баланса',
  description: 'Логирует баланс при смене пользователя.',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui, Capability.Steam, Capability.Configs],
  async init(ctx: PluginContext): Promise<InitResult> {
    if (!ctx.granted.has(Capability.Steam)) {
      ctx.log.warn('steam capability not granted — bailing');
      return;
    }

    const user = await ctx.sb.steam.getCurrentUserAsync();
    ctx.log.info('initial user accountName=<redacted>', {
      hasBalance: typeof user.balance === 'number',
    });

    const button = ctx.sb.ui.addHeaderButton({
      id: 'balance-btn',
      label: user.balanceFormatted ?? '—',
      tooltip: 'Показать баланс',
      onClick: () => {
        ctx.log.info('balance button clicked');
      },
    });

    const unsubscribe = ctx.sb.steam.onUserChange((u) => {
      if (u && u.balanceFormatted) {
        button.setLabel(u.balanceFormatted);
      }
    });

    return () => {
      unsubscribe();
      button.remove();
    };
  },
});
```

## Failure modes

| Симптом                                       | Причина                                         | Где смотреть                              |
|-----------------------------------------------|-------------------------------------------------|-------------------------------------------|
| Плагин не появился в логах                    | `id` нет в manifest или не подходит regex       | `plugin '<id>' registered but not in manifest` |
| `cross-validation failed`                     | поля бандла не совпадают с подписанными         | warn-лог содержит причину                 |
| `apiVersion ... not supported`                | плагин старше / новее фреймворка                | поднять framework или понизить apiVersion |
| `ctx.sb.<cap>` undefined                      | capability не выдан в manifest                  | проверить `ctx.granted.has(...)`          |
| `init` зависает 30s                           | случайно бесконечный await                      | таймаут с info-логом; rollbackAll работает|

Полный разбор — [`./troubleshooting.md`](./troubleshooting.md).

## Embed-мост (`embedOrigins`)

Плагины, открывающие cross-origin страницы через `ctx.sb.ui.openWindow({url})`,
могут подключить двусторонний `window.postMessage`-мост через опцию
`embedOrigins`. Она задаёт дополнительные https-origin'ы (помимо origin
стартового `url`), которым обёртка iframe отвечает на embed-рукопожатие
(`sb:ready`). Relay валидирует каждый origin, лимит — 8 записей.

```ts
await ctx.sb.ui.openWindow({
  id: 'orders', title: 'Заказы', url: 'https://steambalance.cc/booster/orders',
  width: 900, height: 600,
  embedOrigins: ['https://pay.steambalance.cc'],
});
```

Полный протокол, сниппет детекции для страницы и origin-правила —
[`./embed-bridge.md`](./embed-bridge.md).

## See also

- [`./capabilities.md`](./capabilities.md) — полный список capability и правила гейтинга.
- [`./lifecycle.md`](./lifecycle.md) — таймлайн init/cleanup, hot-reload.
- [`./scope-api.md`](./scope-api.md) — auto-cleanup helpers.
- [`./getting-started.md`](./getting-started.md) — 30-минутный туториал.
- [`./embed-bridge.md`](./embed-bridge.md) — протокол embed-моста для url-окон.
