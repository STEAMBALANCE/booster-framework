# Lifecycle

Этот документ описывает жизненный цикл одного плагина — от момента
загрузки бандла до cleanup'а на rollback. Источник истины —
`booster-framework/src/plugins/{bootstrap,lifecycle,registry}.ts` и
`booster-framework/src/api/{lifecycle,plugins}.ts`.

## Регистрация: `sb.plugins.register`

```ts
sb.plugins.register({
  id: 'my-plugin',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Мой плагин',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  init(ctx) { /* ... */ },
});
```

- **Sync**. `register` сразу проверяет shape (`id` matches
  `PLUGIN_ID_RE`, `displayName` непустой, `init` is function и т.д.) и
  кладёт `PluginManifest` в `PluginRegistry`.
- **Ровно один раз** на бандл. Повторная регистрация того же `id` в
  пределах одного выполнения бандла — sync throw
  `plugin '<id>' already registered` (`PluginRegistry.add`). При
  re-injection бандл выполняется заново с чистым реестром, поэтому
  повторная регистрация тех же `id` в новом цикле — это норма.
- **`init` НЕ вызывается** немедленно. Framework делает это позже, в
  `drainPluginsOnReady`, после собственного bootstrap'а.

## Когда `init` вызывается

```
[t0]  Bundle eval starts (C++ Runtime.evaluate)
[t1]  sb.plugins.register(...) пушит manifest в registry
[t2]  Bundle eval finishes
[t3]  Framework's lifecycle.ready() resolves (внутренний bootstrap done)
[t4]  drainPluginsOnReady на microtask после ready
[t5]    waitForExpectedRegistrations (≤1s soft wait)
[t6]    filterEligiblePlugins (kind / apiVersion / urlPattern / user-disabled / cross-validate)
[t7]    makeContext(plugin) per плагин
[t8]    runPluginInits (sequential, 30s timeout each)
[t9]  outcomes stashed на _pluginOutcomes
```

В разрезе одного плагина:

1. **eval** — V8 выполняет IIFE-бандл.
2. **register** — `sb.plugins.register` синхронно валидирует и регистрирует.
3. **cross-validate** — поля бандла сверяются с подписанной
   manifest-entry (см. [`./plugin-contract.md`](./plugin-contract.md)).
4. **build PluginContext** — capability-gated `sb`, per-plugin scope,
   configs, log.
5. **`await init(ctx)`** — может быть sync или async; одна на каждый
   `contextKind`, где плагин заявлен.
6. **InitResult** — `void | (() => void | Promise<void>)`. Если
   возвращена функция — сохраняется как cleanup-fn.
7. **Live** — плагин работает; внешние события (URL change, bus, user
   change) триггерят его handler'ы.
8. **rollback** — `lifecycle.rollbackAll()` (re-injection, hot-reload,
   panic-stop). Сначала `scope._abort()` (синхронно вырубает все
   `ctx.scope.*`-ресурсы), потом cleanup-fn-ы в LIFO (5s timeout).

## Контракт `init(ctx)`

Поле точки входа называется `init` (не `mount`). Сигнатура:

```ts
init: (ctx: PluginContext) => InitResult | Promise<InitResult>;

type InitResult = void | (() => void | Promise<void>);
```

Что в `ctx`:

| Поле           | Тип                       | Описание                                          |
|----------------|---------------------------|---------------------------------------------------|
| `pluginId`     | `string`                  | Алиас на `manifest.id` для логов / меток.        |
| `contextKind`  | `ContextKind`             | Какой kind вызвал текущий init (важно если плагин в нескольких). |
| `apiVersion`   | `number`                  | Эффективная версия API.                          |
| `granted`      | `ReadonlySet<Capability>` | Эффективный capability-set после intersection.    |
| `sb`           | `SbApi`                   | Capability-gated копия `window.sb`.               |
| `scope`        | `ScopeApi`                | Per-plugin AbortController + auto-cleanup helpers.|
| `configs`      | `ConfigsApi`              | Per-plugin namespace (если `Configs` granted).    |
| `log`          | `LogApi`                  | Structured logger с `[plugin:<id>]` префиксом.    |
| `signal`       | `AbortSignal`             | Alias на `ctx.scope.signal`.                      |

Expected return:

- **`void` / undefined** — нет cleanup. Плагин полагается на `ctx.scope.*`
  для всей деаллокации (которая снимется на rollback).
- **`() => void`** — sync cleanup. Вызывается на rollback в LIFO с 5s
  таймаутом.
- **`() => Promise<void>`** — async cleanup. То же, но awaited.

Ровно одно значение возвращается за один `init`. Множественные cleanup'ы
— объединяйте в одну функцию.

## Поведение по `ContextKind`

Framework инжектирован в каждый из 4 kinds Steam'а независимо, в разных
V8-контекстах. Каждый kind — отдельный bundle eval, отдельный
`PluginRegistry`, отдельный `drainPluginsOnReady`.

| ContextKind     | `ctx.sb.context.url` | DOM            | Особенности                             |
|-----------------|----------------------|-----------------|-----------------------------------------|
| `Main`          | URL главного окна Steam | да           | Header / library / store-tab. UI capability имеет смысл. |
| `Shared`        | пусто (`about:blank`) | нет           | `SharedJSContext`: глобальный SDK Steam. UI не доступен (нет DOM). Подходит для relay-only логики. |
| `TabbedBrowser` | URL tabbed-окна       | да             | News, Payment. CSP мягче, чем Web.       |
| `Web`           | URL embedded-страницы | да             | Store, community, help. CSP жёстче — некоторые inline-стили запрещены. |

Если плагин заявлен в `[Main, Web]`, его `init` вызовется ДВАЖДЫ — один
раз в Main, один раз в Web. Это **разные V8-контексты**, у них нет
shared-памяти. Для синхронизации между kinds — `sb.bus.publish/subscribe`
(cross-target broadcast). См. [`./bus-api.md`](./bus-api.md).

`Shared` имеет специфику:

- `ctx.sb.ui === undefined` де-факто (DOM нет, `addHeaderButton` не имеет
  смысла даже при granted `Ui`).
- `ctx.sb.pages === undefined` де-факто (URL нет).
- `urlPatterns` в manifest-entry игнорируется (нет URL для матчинга).

## Hot-reload (dev only)

В dev-EXE (`SB_PRODUCTION=0`) bundle-watcher следит за `out/*.js`
файлами. На изменение нативный инжектор:

1. `lifecycle.rollbackAll()` — scope abort + DOM rollback + cleanup-fn-ы.
2. Перечитывает бандл и повторно его выполняет. Способ зависит от
   context kind:
   - **Main / Shared / TabbedBrowser** — повторный `Runtime.evaluate` в
     **том же** V8-контексте, без перезагрузки страницы;
   - **Web** — `Page.reload`: JS-контекст store-страницы нельзя
     переинициализировать через ре-evaluate, поэтому страница
     перезагружается (это новый контекст), а инъекция повторяется через
     `Page.addScriptToEvaluateOnNewDocument`.
3. Фреймворк-IIFE выполняется заново и строит **новый** `PluginRegistry`
   (`index.ts` создаёт `new PluginRegistry()` на каждый bootstrap), после
   чего плагины снова вызывают `sb.plugins.register`. Реестр не переживает
   re-injection — он каждый раз создаётся с нуля.

Что сбрасывается на hot-reload (= то же, что на любом rollback):

| Аспект                                    | Состояние после rollback        |
|-------------------------------------------|----------------------------------|
| `ctx.scope.*` ресурсы (timer, fetch, listener, observer) | снимаются синхронно через `scope._abort` |
| DOM mutations через `sb.ui.*`             | rollback'ятся framework registry |
| `sb.bus.subscribe` подписки               | дропаются на scope abort         |
| `sb.pages.register` mounts                | unmount-fn вызывается            |
| cleanup-fn из init                        | вызывается LIFO с 5s timeout     |
| `ctx.configs.read/write` файлы            | **сохраняются** — зашифрованные libsodium blob'ы на диске |

Persistent state — ТОЛЬКО `ctx.configs.*`. Module-level переменные в
бандле не сохраняются между hot-reload'ами; ваш плагин обязан
сериализовать всё, что критично, в configs.

В production EXE bundle-watcher отсутствует — hot-reload не существует.
Аналог — bundle-hot-update через manifest-poll, который тоже завершается
`rollbackAll` + новая инжекция.

## Cleanup contract

Cleanup-fn возвращается из `init` и вызывается:

- на `lifecycle.rollbackAll()` (re-injection / EXE shutdown / hot-reload);
- порядок — **LIFO** (в обратном порядке регистрации);
- per-cleanup timeout — **5 секунд** (Promise.race с таймером);
- ошибки cleanup'а **swallow**'ятся (другие плагины должны cleanup'нуться
  даже если один упал).

```ts
async init(ctx: PluginContext): Promise<() => Promise<void>> {
  const button = ctx.sb.ui.addHeaderButton({ /* ... */ });
  const unsubscribe = ctx.sb.steam.onUserChange(() => { /* ... */ });

  return async () => {
    unsubscribe();
    button.remove();
    // async-cleanup: можно дождаться flush
    await ctx.configs.write('state', { lastSeen: Date.now() });
  };
}
```

> **`ctx.scope.*` vs cleanup-fn.** Обычно scope покрывает 95% случаев
> сам — `setTimeout`, `setInterval`, `fetch`, `addEventListener`,
> `MutationObserver` снимаются автоматически. Cleanup-fn нужен только
> для DOM-операций, обёрток над third-party API (которые не принимают
> AbortSignal) и финальной persistence (write в configs). См.
> [`./scope-api.md`](./scope-api.md).

## Failure isolation

`runPluginInits` (lifecycle.ts:27) гарантирует, что:

- **throw / reject в одном init не ломает остальные**. Each iteration
  обёрнут в `try/catch`; outcome помечается `ok: false, error: ...`.
- **30-секундный init timeout**. Если `init` не зарезолвился — outcome
  `ok: true, cleanup: undefined`. Init promise не отменяется
  (`Runtime.evaluate` не cancellable); поздний reject ловится `.catch`
  чтобы не было unhandledRejection.
- **Late cleanup дропается**. Cleanup-fn, возвращённая ПОСЛЕ таймаута,
  не сохраняется. DOM-rollback всё равно сработает через framework
  registry (плагин использовал `sb.ui.*` — те мутации tracked'ы).
- **Cleanup ошибки swallow**'ятся (`runPluginCleanups` ловит throw),
  чтобы один плохой cleanup не блокировал другие.

Сценарии:

| Что произошло                          | Что увидят другие плагины       |
|----------------------------------------|----------------------------------|
| Плагин X throw в init                  | Свой init нормально запустится  |
| Плагин X promise rejected              | Свой init нормально запустится  |
| Плагин X завис 30s+                    | Свой init дождётся истечения таймаута и продолжит — sequential! |
| Плагин X cleanup throw на rollback     | Свой cleanup всё равно вызовется|

**Sequential note**: `runPluginInits` идёт ПОСЛЕДОВАТЕЛЬНО (`for...of` с
`await`). Это значит зависший плагин блокирует всю очередь до своего
таймаута. Это намеренно: порядок init важен (cleanup в LIFO!), и
parallel-init выявил бы race'ы в shared DOM. Если у вас критичный
плагин, который должен запуститься быстро — поставьте его раньше в
registry order (порядок eval'а через `--dev-plugin=` флаги).

## `lifecycle.ready()` vs `sb.plugins.ready()`

`sb.lifecycle.ready()` — фреймворк прошёл свой bootstrap (CDP-bridge,
relay, native-warn handler). Резолвится ДО `drainPluginsOnReady`.

`sb.plugins.ready()` — все зарегистрированные плагины завершили `init`
(success или failure). Полезно когда плагин A хочет дождаться, что
плагин B инициализировался:

```ts
async init(ctx) {
  await ctx.sb.plugins.ready();
  // теперь sb.bus.publish дойдёт до B'шных подписок гарантированно
}
```

**Не вызывайте `sb.plugins.ready()` ВНУТРИ `init`** — пока ваш `init` не
вернётся, `ready` не зарезолвится, и вызов зависнет до истечения
30-секундного init-таймаута (`runPluginInits` гонит каждый `init` с
таймаутом, так что это не вечный deadlock, но 30 с простоя). Альтернатива —
`queueMicrotask(() => sb.plugins.ready().then(...))` или дождаться
сначала на bus-pong.

## Канонический пример с cleanup

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

interface Persisted { readonly count: number; }

sb.plugins.register({
  id: 'cleanup-demo',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Cleanup demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui, Capability.Configs, Capability.Steam],
  async init(ctx: PluginContext): Promise<InitResult> {
    const prev = await ctx.configs.read<Persisted>('state');
    let count = prev?.count ?? 0;

    const button = ctx.sb.ui.addHeaderButton({
      id: 'cleanup-btn',
      label: `Count: ${count}`,
      onClick: () => {
        count++;
        button.setLabel(`Count: ${count}`);
      },
    });

    // scope.setInterval автоматически снимется на rollback — не нужно
    // вручную clearInterval в cleanup.
    ctx.scope.setInterval(() => {
      ctx.log.debug('tick', { count });
    }, 10_000);

    // subscribe возвращает unsubscribe — но scope покрывает это сам.
    const unsubscribe = ctx.sb.steam.onUserChange((u) => {
      if (u) ctx.log.info('user changed', { hasBalance: u.balance != null });
    });

    // Async cleanup: персистим финальный count перед deallocation.
    return async () => {
      unsubscribe();
      button.remove();
      await ctx.configs.write<Persisted>('state', { count });
      ctx.log.info('cleaned up', { finalCount: count });
    };
  },
});
```

## See also

- [`./plugin-contract.md`](./plugin-contract.md) — full PluginManifest +
  PluginContext field reference.
- [`./scope-api.md`](./scope-api.md) — standard helpers для async-ресурсов.
- [`./capabilities.md`](./capabilities.md) — что gated, как effective set
  считается.
- [`./troubleshooting.md`](./troubleshooting.md) — когда init не
  отрабатывает или cleanup не вызывается.
