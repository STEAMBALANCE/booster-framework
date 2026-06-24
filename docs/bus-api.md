# Bus API

`ctx.sb.bus.*` — cross-target / cross-plugin pub/sub. Capability —
`Capability.Bus` (гейтится по granted-набору манифеста, как и остальные
capability). Источник истины — интерфейс `BusApi` в
`booster-framework/src/api/api-types.ts` + `booster-framework/src/api/bus.ts`
+ `booster-framework/src/plugins/bus.ts` + сторона нативного инжектора
(bus-роутер и bus-publish IPC-операция).

```ts
interface BusApi {
  publish(topic: string, data?: unknown): void;
  subscribe(topic: string, cb: (data: unknown) => void): () => void;
}
```

**Зачем нужен.** Это единственный способ для плагина в `ContextKind.Main`
сообщить что-то плагину в `ContextKind.Web` (или наоборот, или Shared
→ всем) — между ними нет shared-памяти, нет общего JS-окружения. Bus
ходит через нативный инжектор (`bridge.call('bus.publish', ...)` →
нативный broadcaster → `Runtime.evaluate` в каждом target session'е).

**Где доступно.** Во всех `ContextKind`. Topic-broadcast достигает всех
**других** target'ов с подпиской на topic; сам publisher свой broadcast
не получает (no self-loop).

## `publish(topic, data?)`

Fire-and-forget. **Синхронный** в плане валидации, асинхронный в плане
доставки (bridge call → C++ → eval).

```ts
ctx.sb.bus.publish('my-plugin.ping', { at: Date.now() });
```

### Topic — правила имени

Низкоуровневый регекс в `BusApi` (`bus.ts:11`):

```
^[a-z][a-z0-9.\-]{0,63}$
```

- lowercase letter в начале;
- length 1..64;
- разрешены `a-z`, `0-9`, `.`, `-`.

**Plugin-side enforcement** (`plugins/bus.ts::createPluginBus`):

```ts
const requiredPrefix = pluginId + '.';
publish(topic, data) {
  if (!topic.startsWith(requiredPrefix)) {
    throw new Error(`bus.publish: topic must start with '${requiredPrefix}' ...`);
  }
  realBus.publish(topic, data);
}
```

То есть плагин **обязан** публиковать только в topics с префиксом
`<pluginId>.`. Например плагин `booster-checkout` публикует в
`booster-checkout.popup-opened`, `booster-checkout.amount-changed`. Это
изолирует namespace'ы и предотвращает спуфинг (плагин A не может
имитировать publish'и плагина B).

> `subscribe` **не** имеет prefix-ограничения — любой плагин может
> слушать чужой topic. Это даёт паттерн «сторонний плагин подписывается
> на события booster-checkout» без специальных разрешений.

### Sync throw на publish

| Условие                                            | Сообщение |
|---------------------------------------------------|-----------|
| Topic не матчится `TOPIC_RE` (нижний уровень)     | `sb.bus.publish: invalid topic '<topic>'` |
| Topic не начинается с `<pluginId>.` (per-plugin)  | `bus.publish: topic must start with '<pluginId>.' (got '<topic>')` |
| `data` не сериализуется в JSON (`Function`, циклы) | `sb.bus.publish: data not JSON-serializable: <error>` |
| `JSON.stringify(data).utf8Bytes > 16384`          | `sb.bus.publish: payload too large (<N> > 16384)` |

Все четыре — **синхронный throw**, плагин видит ошибку сразу, не через
promise rejection.

> **16 KB = байты UTF-8**, не `.length` UTF-16. Текст на кириллице
> может быть под cap'ом по `.length` и над cap'ом по `.byteLength`.
> Framework считает байты, C++ тоже (`kBusMaxPayloadBytes = 16 * 1024`).

### Payload — JSON-serializable

- Любые plain-объекты, массивы, числа, строки, booleans, `null`.
- `undefined` в значениях полей дропается `JSON.stringify` (`{ a:
  undefined }` → `{}`).
- `Date`, `Map`, `Set`, `Function`, `Symbol`, `Bigint` — теряются или
  бросают.
- Циклы — sync throw.

Если `data` не передан — публикуется `null` (`data ?? null`).

### Delivery semantics

- **Cross-target.** Broadcast уходит во все **другие** session'ы (main,
  shared, tabbedBrowser, web) — всем, кто подписан.
- **No self-loop.** Sender не получает свой собственный publish (см.
  `BusBroadcaster::Publish` в C++ — sender_session_id отфильтровывается).
  Если нужно «вызвать собственный handler» — вызывайте функцию напрямую,
  не через bus.
- **Fire-and-forget.** Bridge errors логируются через `nativeWarn`, но
  publish-promise не пробрасывается caller'у (publish — `void`).
- **Не reliable.** Если target ещё не загрузился или уже rollback'нут —
  его подписчики этот broadcast не получат. Нет re-delivery / queue.

### Re-entry safety

`publish` внутри handler'а другого `subscribe` — допустим. Subscribers
итерируются по snapshot Set'а; новые добавления не сработают на
текущий broadcast, но сработают на следующий.

## `subscribe(topic, cb)`

```ts
const unsubscribe = ctx.sb.bus.subscribe('other-plugin.event', (data) => {
  ctx.log.info('got event', { data });
});
ctx.signal.addEventListener('abort', unsubscribe, { once: true });
```

- **`topic` валидируется** тем же `TOPIC_RE` (нижний уровень). На invalid
  — sync throw `sb.bus.subscribe: invalid topic '<topic>'`.
- **`cb` обязан быть функцией.** На `null`, объект, undefined — sync
  throw `sb.bus.subscribe: cb must be a function ...`.
- **Auto-cleanup на scope abort.** `plugins/bus.ts::createPluginBus`
  навешивает `signal.addEventListener('abort', unsub)` для каждой
  подписки. Когда `lifecycle.rollbackAll()` сработает (re-injection,
  hot-reload) — подписки снимутся, плагину не нужно вручную
  `unsubscribe()`. Возвращаемый `unsubscribe` нужен только если
  плагин хочет отписаться раньше rollback'а.

### Errors в callback'е

```ts
ctx.sb.bus.subscribe('foo', () => { throw new Error('boom'); });
```

Throw в callback'е **не пробрасывается** в broadcast loop — иначе один
сломанный subscriber starve'ил бы остальных. Ошибка логируется через
`console.error`:

```
[sb.bus] subscriber threw for topic 'foo' Error: boom
    at ...
```

Behavior: ошибку **видно** в DevTools / nativeWarn, остальные subscribers
получают broadcast штатно.

### Sync delivery

`cb` вызывается **синхронно** в момент диспатча (внутри
`__sb_bus_dispatch`, C++ инжектит этот call в target session). Если
handler'у нужна async работа — оберните в IIFE / queueMicrotask:

```ts
ctx.sb.bus.subscribe('feed.refresh', (data) => {
  void (async () => {
    await ctx.scope.fetch('/api/refresh');
    // ...
  })();
});
```

### Future-only

`subscribe` ловит **будущие** broadcast'ы. Если другой плагин уже
publish'нул до того, как этот плагин подписался — событие потеряно.
Архитектурный момент:

- Для steady-state event'ов (тик / клик / навигация) — норма.
- Для «initial state» — публикуйте при подписке либо используйте
  separate snapshot-механизм (например `ctx.configs.read` + bus
  для обновлений).

## Topic conventions

Поскольку framework enforce'ит `<pluginId>.` префикс на publish'е,
плагины автоматически идут под своим namespace'ом. Дальше — соглашения:

| Шаблон                          | Когда использовать |
|----------------------------------|---------------------|
| `<pluginId>.<verb>`              | Простое событие: `booster-checkout.opened`, `booster-checkout.closed`. |
| `<pluginId>.<resource>.<verb>`   | Множественные ресурсы: `booster-checkout.amount.changed`, `booster-checkout.popup.shown`. |
| `<pluginId>.<scope>.<verb>`      | Scoped events: `my-plugin.ui.click`, `my-plugin.net.error`. |

Best practices:

- **Существительное+глагол** в past tense для уведомлений:
  `something.changed`, `popup.opened`, `cart.cleared`.
- **Существительное+глагол** в imperative для команд:
  `feed.refresh`, `popup.hide`. Команды реже — обычно direct API
  достаточно.
- **Никаких parameter'ов в topic'е** (`my.plugin.id-42.opened` → плохо).
  Делайте `my-plugin.opened` + `data: { id: 42 }`.

## Cross-context reachability

Publishing context | Reachable subscribers
-------------------|------------------------
`Main`             | `Shared`, `TabbedBrowser`, `Web` (но не самого `Main`)
`Shared`           | `Main`, `TabbedBrowser`, `Web`
`TabbedBrowser`    | `Main`, `Shared`, `Web`, другие `TabbedBrowser` окна
`Web`              | `Main`, `Shared`, `TabbedBrowser`, другие `Web` страницы

C++ broadcaster знает только session'ы — он рассылает в **все active
session'ы** кроме `sender_session_id`. То есть два инстанса одного
плагина в `Web` (на разных страницах) **видят** publish друг друга.
Это полезно для координации между tab'ами.

> **Внутри одного V8-контекста** publish не доставляется (см. no
> self-loop). Если плагин в `Main` хочет послать event самому себе —
> вызовите функцию напрямую, не через bus.

## Cleanup

Подписки **автоматически** снимаются на `lifecycle.rollbackAll()`
(framework abort → `scope.signal.dispatchEvent('abort')` →
`subscribers.clear()`). Глобальный handler `__sb_bus_dispatch`
**не** удаляется — следующий bootstrap перепишет его свежим closure'ом
(сохраняется чтобы не порвать ещё-идущий broadcast в момент rollback'а).

## Что **не** делать

### Не используйте bus как ACK-механизм

`publish` fire-and-forget. Нет confirm'а, что хотя бы один subscriber
получил event. Если нужен ACK — публикуйте request-id + слушайте
response с тем же id:

```ts
const reqId = Math.random().toString(36).slice(2);
const unsubscribe = ctx.sb.bus.subscribe('other.response', (data) => {
  const r = data as { reqId?: string; result?: unknown };
  if (r.reqId !== reqId) return;
  ctx.log.info('got response', { result: r.result });
  unsubscribe();
});
ctx.sb.bus.publish('my-plugin.request', { reqId, op: 'foo' });
```

Это полезно для cross-context «RPC», но добавьте таймер: если ответ
не пришёл за N секунд — fallback.

### Не публикуйте PII

Bus broadcasts видны всем плагинам с подпиской на topic. Не отправляйте
`accountName`, `steamId`, `email`, raw tokens. Если данные критичны —
держите в локальном scope плагина.

### Не используйте bus для high-frequency event'ов

`publish` идёт через bridge call → C++ → eval. Latency `~5..20 ms`. Не
гоните mousemove или scroll-event'ы через bus — DOM event listener'ы
дешевле в 100 раз.

## Примеры

### Простой ping/pong между плагинами

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

// Плагин A — публикует.
sb.plugins.register({
  id: 'demo-bus-a',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Bus publisher demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Bus],
  init(ctx: PluginContext): () => void {
    // Topic ОБЯЗАН начинаться с pluginId + '.':
    const t = ctx.scope.setInterval(() => {
      ctx.sb.bus.publish('demo-bus-a.tick', { at: Date.now() });
    }, 5_000);
    return () => clearInterval(t);
  },
});
```

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

// Плагин B — подписывается. Subscribe не имеет prefix-ограничения.
sb.plugins.register({
  id: 'demo-bus-b',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Bus subscriber demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Bus],
  init(ctx: PluginContext): void {
    ctx.sb.bus.subscribe('demo-bus-a.tick', (data) => {
      const tick = data as { at: number };
      ctx.log.info('got tick', { ageMs: Date.now() - tick.at });
    });
    // Auto-unsubscribe на rollback через scope.signal — нечего возвращать.
  },
});
```

### Cross-context broadcast (`Main` → `Web`)

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-bus-cross',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Cross-context demo',
  contextKinds: [ContextKind.Main, ContextKind.Web],
  capabilities: [Capability.Bus],
  init(ctx: PluginContext): void {
    if (ctx.contextKind === ContextKind.Main) {
      ctx.sb.bus.publish('demo-bus-cross.greeting', { from: 'main' });
      return;
    }
    // ContextKind.Web: ловим из Main.
    ctx.sb.bus.subscribe('demo-bus-cross.greeting', (data) => {
      ctx.log.info('greeting received', { data });
    });
  },
});
```

### Error в subscriber'е не starve'ит остальных

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-bus-isolate',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Isolation demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Bus],
  init(ctx: PluginContext): void {
    ctx.sb.bus.subscribe('demo-bus-isolate.go', () => {
      throw new Error('boom');           // логируется, не разваливает loop
    });
    ctx.sb.bus.subscribe('demo-bus-isolate.go', (data) => {
      ctx.log.info('second subscriber still fires', { data });
    });
    ctx.sb.bus.publish('demo-bus-isolate.go', { x: 1 });
  },
});
```

### Request/response через unique requestId

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-bus-rpc',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'RPC over bus demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Bus],
  init(ctx: PluginContext): void {
    const reqId = Math.random().toString(36).slice(2);
    const unsubscribe = ctx.sb.bus.subscribe('other.response', (data) => {
      const r = data as { reqId?: string; result?: unknown };
      if (r.reqId !== reqId) return;
      ctx.log.info('rpc result', { result: r.result });
      unsubscribe();
    });
    // Таймер на случай отсутствия ответа:
    ctx.scope.setTimeout(() => unsubscribe(), 5_000);
    ctx.sb.bus.publish('demo-bus-rpc.request', { reqId, op: 'foo' });
  },
});
```

## See also

- [`./capabilities.md`](./capabilities.md) — `Capability.Bus` и
  правила гейтинга capability.
- [`./lifecycle.md`](./lifecycle.md) — авто-cleanup подписок на rollback.
- [`./scope-api.md`](./scope-api.md) — `ctx.scope.fetch` /
  `ctx.scope.setTimeout` для async-handler'ов внутри subscribe'а.
- `framework/README.md § sb.bus` — internal-механика (C++ broadcast,
  `__sb_bus_dispatch`).
