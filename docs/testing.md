# Testing

`@steambalance/booster-framework/testing` — изолированная test-harness для
плагинов. Позволяет прогонять `init(ctx)` плагина в `bun test`
без живого Steam / CDP / native bridge: harness даёт mock-`SbApi`,
который собирает все вызовы плагина в structured-inspector.

Источник истины — `booster-framework/src/testing/index.ts` (~150 LOC).

## API surface

```ts
// Точка входа.
import {
  createTestPluginContext,
  ContextKind,
  Capability,
  type TestPluginContextOptions,
  type TestInspector,
  type DomMutation,
  type BridgeCall,
  type BusPublish,
  type LogEntry,
} from '@steambalance/booster-framework/testing';

interface TestPluginContextOptions {
  pluginId?: string;          // default: 'test-plugin'
  contextKind?: ContextKind;  // default: ContextKind.Main
  apiVersion?: number;        // default: 1
  granted?: Capability[];     // default: Object.values(Capability) — все
}

interface TestInspector {
  domMutations: DomMutation[];   // addHeaderButton / attachPopup / openWindow / openExternalWindow
  bridgeCalls: BridgeCall[];     // configs.read / configs.write
  busPublishes: BusPublish[];    // sb.bus.publish
  logEntries: LogEntry[];        // ctx.log.{trace,debug,info,warn,error}
}

interface DomMutation {
  kind: 'headerButton' | 'popup' | 'window' | 'externalWindow';
  details: object;               // прокинутые в API options
}
interface BridgeCall  { op: string; args: unknown }
interface BusPublish  { topic: string; data: unknown }
interface LogEntry    { level: string; msg: string; meta?: object }

function createTestPluginContext(opts?: TestPluginContextOptions): {
  ctx: PluginContext;
  inspect: TestInspector;
  cleanup: () => void;            // вызывает ctx.scope._abort()
};
```

`TestPluginContextOptions` опционально перекрывают defaults; всё, что
не задано, заполняется sensible-defaults. Сам `ctx` — полноценный
`PluginContext` (с `pluginId`, `contextKind`, `granted`, `sb`, `scope`,
`configs`, `log`, `signal`).

## Plugin-meta utilities

Тот же `@steambalance/booster-framework/testing` ре-экспортирует валидатор и
константы из `src/testing/plugin-meta.ts`. Их используют
плагин-`build.ts` (валидирует `src/plugin-meta.ts` перед сборкой и
пишет `.meta.json` рядом с бандлом в `out/`) и release-pipeline /
approve-plugin CLI нативного инжектора. Это общий source-of-truth
между TS-стороной и валидацией манифеста в нативном инжекторе — менять
имеет смысл синхронно с обеими сторонами.

`.meta.json` — dev-механизм: его читает нативный инжектор только при
загрузке плагина через `--dev-plugin`. На CDN sidecar не стейджится;
в production метаданные плагина живут в его записи подписанного манифеста.

```ts
import {
  validatePluginMeta,
  KNOWN_CAPS,
  KNOWN_KINDS,
  PLUGIN_ID_REGEX,
  SEMVER_REGEX,
  type PluginMeta,
} from '@steambalance/booster-framework/testing';

// PluginMeta — shape sidecar .meta.json:
interface PluginMeta {
  id: string;
  version: string;
  apiVersion: number;
  contextKinds: readonly ContextKind[];
  urlPatterns: readonly string[];
  grantedCapabilities: readonly Capability[];
}

// validatePluginMeta(value): возвращает discriminated union
// { ok: true, meta: PluginMeta } | { ok: false, error: string }.
// Зеркалит правила валидации манифеста в нативном инжекторе:
//   * id regex (PLUGIN_ID_REGEX) — same как kPluginIdRe;
//   * version (SEMVER_REGEX) — lowercase-only pre-release;
//   * apiVersion ≥ 1;
//   * contextKinds non-empty, все из KNOWN_KINDS;
//   * grantedCapabilities non-empty, все из KNOWN_CAPS.
//
// KNOWN_CAPS  = ['ui','steam','configs','bus','pages','keys']
// KNOWN_KINDS = ['main','shared','tabbedBrowser','web']
```

Когда использовать:
- **plugin `build.ts`** — валидировать `src/plugin-meta.ts` ДО эмиссии
  бандла. Build fail-fast если meta невалидна.
- **release `approve-plugin.ts`** CLI (на стороне нативного инжектора) — общая
  валидация input для `approved-plugins.json`.

Не использовать в production runtime — это build-time / dev-tooling
helper. Production `sb` API не зависит от него.

## Базовый сценарий

```ts
import { test, expect } from 'bun:test';
import {
  createTestPluginContext,
  Capability,
} from '@steambalance/booster-framework/testing';

test('addHeaderButton fires expected DOM mutation', () => {
  const { ctx, inspect, cleanup } = createTestPluginContext({
    pluginId: 'my-plugin',
    granted: [Capability.Ui],
  });

  ctx.sb.ui.addHeaderButton({
    id: 'hello',
    label: 'Привет!',
    onClick: () => {},
  });

  expect(inspect.domMutations).toHaveLength(1);
  expect(inspect.domMutations[0].kind).toBe('headerButton');
  cleanup();
});
```

Запуск:

```pwsh
bun test
```

## Capability-gating

Harness честно эмулирует gating: если capability не в `granted`,
соответствующее поле `ctx.sb` будет `undefined` (то же поведение, что
у `buildGatedSb` в продакшене):

```ts
const { ctx, cleanup } = createTestPluginContext({
  granted: [Capability.Ui],   // Steam/Configs/Bus/Pages/Keys недоступны
});

expect(ctx.sb.ui).toBeDefined();
expect(ctx.sb.steam).toBeUndefined();
cleanup();
```

> **Default — все capabilities granted.** Если `granted` не задан,
> harness даёт плагину доступ ко **всему** `SbApi`. Это удобно, но
> тестам, которые проверяют capability-gating, обязательно задавать
> `granted: [...]` явно.

## Inspector — что и как собирается

| Поле inspector'а  | Что захватывается                              |
|-------------------|-------------------------------------------------|
| `domMutations`    | `ui.addHeaderButton`, `ui.attachPopup`, `ui.openWindow`, `ui.openExternalWindow` — каждое с `kind` + `details` (исходные options, плюс auto-prefixed `id`) |
| `bridgeCalls`     | `configs.read`, `configs.write` — каждый как `{ op, args: { pluginId, name, data? } }` |
| `busPublishes`    | `sb.bus.publish(topic, data)` — каждый как `{ topic, data }` |
| `logEntries`      | `ctx.log.{trace,debug,info,warn,error}` — каждый как `{ level, msg, meta }` |

Что в inspector НЕ попадает (по-разному эмулируется):

- `sb.steam.openUrl()` — no-op (Promise<void>);
- `sb.steam.getCurrentUser()` — возвращает `null`;
- `sb.steam.getCurrentUserAsync()` — throw'ит `Error('test: no user')`;
- `sb.steam.getStoreCountry()` — возвращает `undefined`;
- `sb.bus.subscribe()` — возвращает no-op unsubscribe (не доставляет события);
- `sb.pages.register()` — возвращает no-op handle (`unregister` ничего не делает).

Когда тесту нужно «оживить» одно из этих полей — monkey-patch'ить
напрямую (см. секцию «Stubbing» ниже).

## Stubbing — переопределяем поведение mock-API

Подходы — от самого простого до самого структурного.

### 1. Прямой monkey-patch одной функции

```ts
const { ctx, cleanup } = createTestPluginContext({
  granted: [Capability.Steam],
});

ctx.sb.steam.getCurrentUser = () => ({
  accountName: 'test-user',
  steamId: '76561197960287930',
  email: async () => 'user@example.com',
  emailValidated: async () => true,
  ipCountry: async () => 'RU',
  language: async () => 'russian',
});

const u = ctx.sb.steam.getCurrentUser();
expect(u?.accountName).toBe('test-user');
cleanup();
```

Работает потому что mock-`SbApi` — это обычный JS-объект без
freezing'а: переписать поле = переопределить mock.

### 2. Подменить configs.read для конкретных данных

```ts
const { ctx, cleanup } = createTestPluginContext({
  pluginId: 'my-plugin',
  granted: [Capability.Configs],
});

ctx.configs.read = async <T>(name: string): Promise<T | null> => {
  if (name === 'settings') return { theme: 'dark' } as T;
  return null;
};

const settings = await ctx.configs.read<{ theme: string }>('settings');
expect(settings?.theme).toBe('dark');
cleanup();
```

## Тест плагина из IIFE-бандла (import-side-effect)

Самый распространённый паттерн: плагин при `import` вызывает
`sb.plugins.register({...})`. Чтобы изолировать `init`, перехватываем
`sb.plugins.register` глобальным stub'ом, забираем callback, прогоняем
с test-context'ом.

```ts
import { test, expect } from 'bun:test';
import {
  createTestPluginContext,
  ContextKind, Capability,
} from '@steambalance/booster-framework/testing';
import type { PluginManifest, PluginContext } from '@steambalance/booster-framework';

test('plugin registers and mounts cleanup', async () => {
  let captured: PluginManifest | null = null;
  (globalThis as { sb?: { plugins: { register: (m: PluginManifest) => void } } })
    .sb = { plugins: { register: (m) => { captured = m; } } };

  // import триггерит sb.plugins.register():
  await import('../src/index');

  expect(captured).not.toBeNull();
  expect(captured!.id).toBe('my-plugin');

  // Прогоняем init с test-context'ом:
  const { ctx, inspect, cleanup } = createTestPluginContext({
    pluginId: captured!.id,
    contextKind: ContextKind.Main,
    granted: [Capability.Ui],
  });

  const cleanupFn = await captured!.init(ctx as PluginContext);

  expect(inspect.domMutations.length).toBeGreaterThan(0);
  expect(inspect.domMutations[0].kind).toBe('headerButton');

  // Mount/cleanup-контракт: init вернул cleanup → вызываем перед cleanup() scope'а.
  if (typeof cleanupFn === 'function') await cleanupFn();
  cleanup();
});
```

> **Mount/cleanup contract.** Если ваш плагин возвращает cleanup-fn из
> `init`, в production framework вызывает её на rollback'е. В тесте —
> вызывайте сами **перед** harness'овским `cleanup()`. Иначе DOM-узлы /
> handle'ы / listener'ы, навешенные руками, останутся «висеть» в jsdom
> и могут заразить следующий тест.

## Тест pages-роутера

`sb.pages.register` в harness'е no-op'ит, но вы можете руками
запустить mount/unmount функции через capture:

```ts
import { test, expect } from 'bun:test';
import {
  createTestPluginContext, Capability,
} from '@steambalance/booster-framework/testing';
import type { PageContext } from '@steambalance/booster-framework';

test('page mount/unmount via captured handler', async () => {
  const { ctx, cleanup } = createTestPluginContext({
    pluginId: 'my-plugin',
    granted: [Capability.Pages],
  });

  let mountCount = 0;
  let unmountCount = 0;
  type MountFn = (pc: PageContext) => void | (() => void) | Promise<void | (() => void)>;
  let capturedMount: MountFn | null = null;

  ctx.sb.pages.register = (opts) => {
    capturedMount = opts.mount as MountFn;
    return { unregister: () => {} };
  };

  // Плагин регистрирует страницу:
  ctx.sb.pages.register({
    name: 'store-page',
    match: { url: /\/store\// },
    mount: () => {
      mountCount++;
      return () => { unmountCount++; };
    },
  });

  // Симулируем заход на страницу:
  const ac = new AbortController();
  const unmount = capturedMount!({ url: new URL('https://store.steampowered.com/'), signal: ac.signal });
  expect(mountCount).toBe(1);

  // Симулируем выход:
  if (typeof unmount === 'function') unmount();
  expect(unmountCount).toBe(1);

  cleanup();
});
```

## Тест bus pub/sub

`sb.bus.publish` пишется в `inspect.busPublishes`. `subscribe` —
no-op (harness не маршрутизирует topics). Если вы хотите ПРОВЕРИТЬ,
что плагин подписался — monkey-patch:

```ts
import { test, expect } from 'bun:test';
import {
  createTestPluginContext, Capability,
} from '@steambalance/booster-framework/testing';

test('publish records to inspector', () => {
  const { ctx, inspect, cleanup } = createTestPluginContext({
    pluginId: 'my-plugin',
    granted: [Capability.Bus],
  });

  ctx.sb.bus.publish('my-plugin.event', { x: 1 });

  expect(inspect.busPublishes).toEqual([
    { topic: 'my-plugin.event', data: { x: 1 } },
  ]);
  cleanup();
});

test('subscribe call captured via monkey-patch', () => {
  const { ctx, cleanup } = createTestPluginContext({
    pluginId: 'my-plugin',
    granted: [Capability.Bus],
  });

  const subs: { topic: string; cb: (data: unknown) => void }[] = [];
  ctx.sb.bus.subscribe = (topic, cb) => {
    subs.push({ topic, cb });
    return () => {};
  };

  ctx.sb.bus.subscribe('any-plugin.event', () => {});
  expect(subs).toHaveLength(1);
  expect(subs[0].topic).toBe('any-plugin.event');

  // Симулируем доставку события:
  subs[0].cb({ payload: 42 });
  cleanup();
});
```

## Snapshot popup HTML

Если плагин собирает inline-HTML для `ui.attachPopup`, можете прогонять
его через `expect(...).toMatchSnapshot()`:

```ts
import { test, expect } from 'bun:test';
import {
  createTestPluginContext, Capability,
} from '@steambalance/booster-framework/testing';

test('popup HTML snapshot', async () => {
  const { ctx, inspect, cleanup } = createTestPluginContext({
    pluginId: 'my-plugin',
    granted: [Capability.Ui],
  });

  await ctx.sb.ui.attachPopup({
    id: 'main-popup',
    html: '<div class="popup">Hello</div>',
    width: 300,
  });

  // bun test --update-snapshots при первом прогоне.
  expect((inspect.domMutations[0].details as { html: string }).html)
    .toMatchSnapshot();
  cleanup();
});
```

> **Когда snapshot полезен.** Только если HTML стабильно генерится
> (одни и те же входы → одна строка). Если есть таймстампы / random
> id'шки — нормализуйте их перед `toMatchSnapshot`, иначе тест будет
> мигать.

## Где складывать тесты

```
my-plugin/
├── src/
│   └── index.ts
├── tests/
│   ├── index.test.ts          # smoke + integration
│   └── feature-X.test.ts
├── package.json
└── tsconfig.json
```

Конвенция: `tests/<unit-name>.test.ts` рядом с `src/`. `bun test`
рекурсивно ищет `*.test.ts` от cwd. См. `booster-plugin-template/tests/`.

## bun test — практика

```pwsh
# Все тесты:
bun test

# Один файл:
bun test tests/index.test.ts

# Watch-режим — pere-runs при изменениях файлов:
bun test --watch

# Coverage:
bun test --coverage
```

Bun test поддерживает Jest-совместимый API (`describe`, `test`, `expect`,
mocks). Подробности — [bun docs § Testing](https://bun.com/docs/test).

## Best practices

### Test mount/cleanup contract явно

Если плагин вернул cleanup из `init`, вызовите её до `cleanup()`
harness'а. Иначе jsdom потащит созданные узлы в следующий тест:

```ts
const cleanupFn = await plugin.init(ctx);
// ... assertions ...
if (typeof cleanupFn === 'function') await cleanupFn();
cleanup();   // harness's scope.abort
```

### Test idempotency mount → unmount → mount

Перерегистрация (hot-reload) — реальный сценарий в dev. Тест должен
гарантировать, что повторный init не leak'ает state:

```ts
const cleanupA = await plugin.init(ctxA);
await cleanupA?.();
const cleanupB = await plugin.init(ctxB);   // на свежем ctx
expect(inspectB.domMutations).toHaveLength(1);   // mount'ит ровно одну кнопку
await cleanupB?.();
```

### Не полагайтесь на real Steam API внутри теста

`sb.steam.getCurrentUser()` в harness'е возвращает `null`.
Если плагин зависит от данных — stub'ьте их (см. «Stubbing»).
Не пытайтесь дозваться до живого Steam — это unit-тест, не E2E.

### Используйте `cleanup()` всегда

Harness'овский `cleanup()` вызывает `scope._abort()`. Без него
`ctx.signal.aborted` остаётся `false`, и любые `scope.setTimeout`
из плагина продолжат тикать до конца процесса тестов. На скромном
наборе это незаметно; на большом — пять тестов с забытыми
`setInterval`'ами могут замедлить прогон.

### Тестируйте capability-denial path

Плагин должен корректно отрабатывать «capability не выдан». Проверьте
это явным тестом с уменьшенным `granted`:

```ts
test('plugin gracefully handles missing Steam', async () => {
  const { ctx, cleanup } = createTestPluginContext({
    granted: [Capability.Ui],   // без Steam
  });

  // ctx.sb.steam === undefined; плагин не должен крашиться:
  await plugin.init(ctx);

  cleanup();
});
```

### Не злоупотребляйте snapshot'ами

`toMatchSnapshot` хорош для стабильного HTML/JSON. Если outputs зависят
от Date.now / Math.random / UUID — нормализуйте перед сравнением. Иначе
вы получите flaky тесты, которые «переписывают snapshot'ы» как ритуал.

### Один `createTestPluginContext` на тест

Каждый тест строит свежий `ctx`. НЕ делайте global ctx в `beforeAll` —
inspect между тестами начнёт mixed-up'иться, capability-set'ы потекут.
Harness дёшев (несколько kB allocations), без overhead'а.

## Что harness НЕ покрывает

- **Real native bridge.** `bridge.notify` mock'нут; реального CDP-вызова
  не происходит. Если плагин зависит от native-response'а (например,
  `configs.read` с осмысленными данными), stub'ьте через monkey-patch.
- **Real DOM.** harness не вставляет DOM-узлы — он только записывает,
  что плагин ВЫЗВАЛ. Если тест проверяет DOM-структуру, нужен
  jsdom + руками построенный DOM-tree.
- **Real bus broadcast.** subscribe — no-op. Если хотите cross-plugin
  scenarios — соберите свой собственный mini-bus в тесте.
- **Lifecycle timeouts.** `INIT_TIMEOUT_MS=30_000`, `CLEANUP_TIMEOUT_MS=5_000`
  из `plugins/lifecycle.ts` — harness'ом не симулируются. Если тест
  должен проверить timeout-семантику — используйте `bun:test`'s
  `setTimeout` mocking.

## See also

- [`./plugin-contract.md`](./plugin-contract.md) — `PluginManifest`,
  `PluginContext`, `InitResult`.
- [`./capabilities.md`](./capabilities.md) — полный набор capability и правила гейтинга `granted`-набора.
- [`./lifecycle.md`](./lifecycle.md) — init/cleanup timeouts, rollback.
- [`./troubleshooting.md`](./troubleshooting.md) — где смотреть логи,
  что чекать когда плагин не виден.
- `booster-framework/src/testing/index.ts` — исходный код harness'а.
- `booster-plugin-template/tests/index.test.ts` — канонический example
  test'а (sb.plugins.register capture + init + cleanup).
