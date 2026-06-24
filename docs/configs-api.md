# Configs API

`ctx.configs.*` — per-plugin персистентный JSON-storage. Доступен
только при наличии capability `Capability.Configs` в манифесте плагина.
Источник истины — интерфейс `ConfigsApi` в
`booster-framework/src/api/api-types.ts` +
`booster-framework/src/plugins/configs.ts` + сторона нативного
инжектора (configs-store и config read/write IPC-операции).

```ts
interface ConfigsApi {
  read<T = unknown>(name: string): Promise<T | null>;
  write<T = unknown>(name: string, data: T): Promise<void>;
}
```

> Доступно как `ctx.configs.*` (per-plugin scope с авто-инжектом
> `pluginId` в IPC envelope) и как `ctx.sb.configs.*` (тот же интерфейс,
> тоже per-plugin). Обе ссылки указывают на один и тот же объект для
> того же плагина — `plugins/configs.ts::createPluginConfigs` строит
> wrapper'ы.

**Где доступно.** Во всех `ContextKind`. На стороне C++ Configs Store —
один на весь EXE: разные таргеты пишут в одну директорию, в
plugin-namespace, под общим crypto-ключом.

## API surface (всего две операции)

| Метод                     | Тип             | Что делает |
|---------------------------|-----------------|------------|
| `read<T>(name)`           | `Promise<T \| null>` | Читает blob, расшифровывает, парсит как JSON. На любой промах — `null`. |
| `write<T>(name, data)`    | `Promise<void>`      | Сериализует JSON, шифрует, пишет атомарно. Reject с native error string на отказ. |

**`delete`, `list`, `exists`** — отсутствуют. Если данных больше не
нужно, пишите `null` или дефолт; если нужно "удалить плагин" — это
делает injector через `DeletePluginConfigs(plugin_id)` при выпиле
плагина из манифеста, а не runtime-плагин сам.

## `read<T>(name)`

Возвращает `T | null`. **Все промахи объединены в `null`:**

| Что произошло               | Результат | Лог на C++ стороне (warn) |
|-----------------------------|-----------|---------------------------|
| Файл отсутствует            | `null`    | `read '<id>/<name>' failed: file missing` |
| Конфиг-директория отсутствует | `null`  | `read '<id>/<name>' failed: configs dir missing` |
| Файл > 256 KB (sanity-cap)  | `null`    | `read '<id>/<name>' failed: file too large (...)` |
| Decrypt fail (повреждённый или подделанный файл — MAC mismatch) | `null` | `read '<id>/<name>' failed: decrypt` |
| Plaintext не парсится как JSON | `null` | `read '<id>/<name>' failed: not json` |
| Invalid name (regex)        | `null`    | `read failed: invalid name '<name>'` |

Caller трактует все промахи одинаково: данных нет, дефолт.

```ts
interface Saved { readonly counter: number; }
const prev = await ctx.configs.read<Saved>('state');
const counter = (prev?.counter ?? 0) + 1;
```

**Типизация `T` — runtime un-checked.** TypeScript generic — это
аннотация; reality — `JSON.parse` вернёт что угодно из того, что было
записано. Если плагин писал старую схему — `read` вернёт её. Делайте
schema-валидацию на стороне плагина (zod / runtime-guard / просто
`if`-ладдер) перед использованием.

## `write<T>(name, data)`

Сериализует `data` через `JSON.stringify`, шифрует libsodium'ом
secretbox, пишет атомарно (`WriteAllBytesAtomic`: tmp-файл + rename).

```ts
await ctx.configs.write<Saved>('state', { counter });
```

**Reject** на:

- `invalid plugin_id` — почти невозможно для нормального плагина
  (`pluginId` фиксируется через bridge closure).
- `invalid config name` — name не подходит под regex (см. ниже).
- `per-plugin quota exceeded (4 MB)` — суммарный размер plaintext в
  директории плагина + новый файл > 4 MB.
- `mkdir`/`io` ошибки от файловой системы — диск полон, ACL,
  read-only volume и т.п.
- `encrypt failure` — крайне редко (libsodium не возвращает ошибки на
  валидный input).

Promise сам резолвится в `void` на успех — никаких `{ ok: true }` для
caller'а.

## Конфигурация: name + plugin_id

### `name` regex

```
^[a-zA-Z0-9_-]{1,32}$
```

Ограничение enforced'ится configs-store нативного инжектора. Ограничения:

- 1..32 символа;
- ASCII letters/digits, дефис, underscore;
- без точек, slash'ей, спецсимволов — файловое имя складывается прямой
  конкатенацией `<name>.bin`.

Рекомендуемая практика:

- Лаконичный snake_case или kebab-case: `state`, `auth_token`,
  `last-poll`.
- Не дробите слишком мелко — каждый `write` это отдельный atomic
  rename + encrypt-call. Если у плагина 10+ полей — лучше одним JSON
  объектом.

### `plugin_id`

Каждый плагин пишет в **свой** namespace; bridge closure инжектирует
`pluginId` в каждый IPC envelope (`plugins/configs.ts::createPluginConfigs`).
Плагин **не может** указать чужой `pluginId` — это invariant'ом
закреплено: closure пробрасывает `pluginId` мимо аргументов плагина.

C++ сторона дополнительно проверяет:

1. `pluginId` совпадает с regex плагинного id (`^[a-z][a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$`).
2. `pluginId` присутствует в актуальном manifest snapshot'е
   (`snap->ContainsPlugin(plugin_id)`). Если плагин был удалён из
   manifest'а между bundle-eval'ом и `config_read` — операция
   отклоняется с `plugin_id not in current manifest`.

## Persistence model

### Layout на диске

```
%LOCALAPPDATA%\steambooster\configs\
└── <plugin-id>\
    ├── state.bin
    ├── auth_token.bin
    └── last-poll.bin
```

- **Корень** — `%LOCALAPPDATA%\steambooster\` (Win32 `FOLDERID_LocalAppData`,
  путь резолвит нативный инжектор). Создаётся при
  первом запуске.
- **Per-plugin dir** — `<configs_dir>/<plugin-id>/`. Создаётся лениво,
  на первый `write`.
- **Расширение** — `.bin`. Это **зашифрованный** blob, не plain JSON.
  Не открывайте `state.bin` в редакторе.

### Шифрование

libsodium secretbox (`xchacha20-poly1305`) на статическом 32-байтовом
ключе, вшитом в бинарник нативного инжектора. Ключ
один и тот же в dev- и prod-сборках. Это **anti-snoop, а не
anti-tamper**: цель — чтобы любопытный пользователь, открыв `auth.bin`,
увидел шум, а не свой кэшированный JWT. От процесса с произвольным
исполнением кода (он читает и ключ, и plaintext из памяти) шифрование
не защищает. Decrypt падает (`read` → `null`) только при повреждении или
подделке файла — MAC mismatch.

### Atomic write

`platform::WriteAllBytesAtomic` пишет в `<path>.tmp` + `MoveFileEx
MOVEFILE_REPLACE_EXISTING`. Crash / power-loss посередине — старый
файл цел, новый не появился. Без половинных записей.

### Per-plugin quota

Cap — `4 MB` plaintext (`kPerPluginQuotaBytes`). Сумма размеров всех
`.bin`-файлов под `<plugin-id>/` + новый файл (минус старый размер
при overwrite'е) — если > 4 MB → `write` reject'ит с
`per-plugin quota exceeded (4 MB)`.

Этого хватает на JSON-структуру с тысячами записей. Если упёрлись —
вероятно cache (например fetched-from-Steam инвентарь) или blob (PNG в
base64). Решения:

- Перенесите cache в `caches/` каталог через свой IPC (вне scope этого
  storage'а).
- Опубликуйте `BACKLOG.md` запрос на bump'нуть лимит.

### Cap на размер одного файла

`kMaxConfigBytes = 256 KB` ciphertext'а — это reading-time sanity guard
(не write-time). Если каким-то образом файл стал больше — `read`
вернёт `null` с warn-логом. На write'е лимит — quota (4 MB на плагин в
сумме).

## Жизненный цикл данных

- **Persist across hot-reload.** Hot-reload (bundle changed) и
  rollback (`lifecycle.rollbackAll`) **не** трогают конфиг-файлы.
- **Persist across EXE updates.** Self-update сохраняет
  `%LOCALAPPDATA%\steambooster\` (`configs/`, `logs/`, etc) между
  installation'ами.
- **Cleared при удалении плагина из manifest'а** — injector вызовет
  `ConfigsStore::DeletePluginConfigs(plugin_id)` (рекурсивный
  `remove_all` per-plugin директории). Run-time плагин это не
  делает.
- **Не synced между устройствами.** Все данные локальные, никаких
  cloud-sync.

## Best practices

### Один blob на состояние

Не дробите состояние плагина на десяток конфигов. Один JSON объект
проще:

- меньше I/O на boot (`read` каждой записи — отдельный bridge call);
- проще миграция версии схемы;
- атомарность — один write = одно консистентное состояние.

### Schema migration

Версионируйте схему:

```ts
interface SavedV2 {
  readonly version: 2;
  readonly counter: number;
  readonly lastSeenAt: number;
}
type Saved = SavedV2 | { readonly version?: 1; readonly counter: number };

async function loadState(ctx: PluginContext): Promise<SavedV2> {
  const raw = await ctx.configs.read<Saved>('state');
  if (!raw) return { version: 2, counter: 0, lastSeenAt: Date.now() };
  if (raw.version === 2) return raw;
  // v1 migration
  return { version: 2, counter: raw.counter, lastSeenAt: Date.now() };
}
```

### Flush на cleanup

Если плагин держит state в памяти и хочет персистнуть на rollback —
делайте `await ctx.configs.write(...)` в cleanup-fn (см.
[`./lifecycle.md`](./lifecycle.md)). Cleanup имеет 5с лимит — этого
достаточно для одного `write`.

```ts
async init(ctx: PluginContext): Promise<() => Promise<void>> {
  const prev = await ctx.configs.read<Saved>('state');
  let counter = prev?.counter ?? 0;
  // ... плагин работает, инкрементит counter ...
  return async () => {
    await ctx.configs.write<Saved>('state', { counter });
  };
}
```

### Не храните PII в plain виде

Шифрование — это anti-snoop, не серьёзная защита секретов: best
practice — не сохранять `accountName` / `email` / `steamId` в configs,
даже если это удобно. Ключ вшит в бинарник, дамп процесса = дамп ключа.
Если очень нужно — hashing с per-plugin salt и хранение только хэша.

### Не используйте как pub/sub

`write` → другой плагин делает `read` — это **не** механизм
коммуникации. Polling = race condition. Для cross-plugin event'ов —
[`./bus-api.md`](./bus-api.md).

## Примеры

### Boot-counter (минимальный)

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

interface Saved { readonly counter: number; }

sb.plugins.register({
  id: 'demo-configs-boot',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Boot counter demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Configs],
  async init(ctx: PluginContext): Promise<() => Promise<void>> {
    const prev = await ctx.configs.read<Saved>('state');
    const counter = (prev?.counter ?? 0) + 1;
    ctx.log.info('boot count', { counter });
    return async () => {
      await ctx.configs.write<Saved>('state', { counter });
    };
  },
});
```

### Кэшированная отметка времени с TTL

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

interface Cached { readonly fetchedAt: number; readonly payload: unknown; }
const TTL_MS = 5 * 60 * 1000;

sb.plugins.register({
  id: 'demo-configs-ttl',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'TTL cache demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Configs],
  async init(ctx: PluginContext): Promise<void> {
    const cached = await ctx.configs.read<Cached>('feed');
    const fresh = cached && (Date.now() - cached.fetchedAt) < TTL_MS;
    if (fresh) {
      ctx.log.info('cache hit', { ageMs: Date.now() - cached.fetchedAt });
      return;
    }
    const payload = { items: ['a', 'b', 'c'] };  // в реальности — fetch
    await ctx.configs.write<Cached>('feed', { fetchedAt: Date.now(), payload });
  },
});
```

### Multi-name layout — feature-flags + state раздельно

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

interface Flags { readonly enableBeta: boolean; }
interface State { readonly cursor: string; }

sb.plugins.register({
  id: 'demo-configs-multi',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Multi-name demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Configs],
  async init(ctx: PluginContext): Promise<void> {
    const [flags, state] = await Promise.all([
      ctx.configs.read<Flags>('flags'),
      ctx.configs.read<State>('state'),
    ]);
    ctx.log.info('booted', {
      beta:  flags?.enableBeta ?? false,
      cursor: state?.cursor ?? '<empty>',
    });
  },
});
```

### Обработка quota

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-configs-err',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Error handling demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Configs],
  async init(ctx: PluginContext): Promise<void> {
    try {
      await ctx.configs.write('big', { data: 'x'.repeat(5 * 1024 * 1024) });
    } catch (e) {
      ctx.log.warn('configs.write rejected', { reason: String(e) });
      // fallback: усечь и попробовать снова, либо сообщить пользователю
    }
  },
});
```

## See also

- [`./capabilities.md`](./capabilities.md) — почему `ctx.configs` /
  `ctx.sb.configs` доступны только с `Capability.Configs`.
- [`./lifecycle.md`](./lifecycle.md) — что persist'ит между rollback'ами
  (только configs).
- [`./bus-api.md`](./bus-api.md) — для real-time коммуникации между
  плагинами / контекстами, а не `configs.write` + polling.
