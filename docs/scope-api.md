# Scope API

`ctx.scope.*` (alias: `ctx.sb.scope.*`) — управление временем жизни
async-ресурсов плагина. **Не gated capability'ем** — доступен всем
плагинам всегда. Источник истины — `booster-framework/src/api/scope.ts`.

```ts
interface ScopeApi {
  readonly signal: AbortSignal;
  setTimeout(cb: () => void, ms: number): number;
  setInterval(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  clearInterval(id: number): void;
  listen<T extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (ev: T) => void,
    opts?: Omit<AddEventListenerOptions, 'signal'>,
  ): void;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  abortable<T>(p: Promise<T>): Promise<T>;
  observer<T extends { disconnect(): void }>(o: T): T;
}
```

**Зачем нужен.** Плагин — не вечный: он умирает на framework rollback'е
(re-injection, hot-reload, manifest disable, EXE-update). Любой
async-ресурс (таймер, listener, fetch, MutationObserver), оставленный
без cleanup'а — leak: будет крутиться на «отмерших» closures, дёргать
DOM, который уже не наш, потенциально race'ить со следующей инжекцией.
`ctx.scope.*` — тонкая обёртка, которая привязывает ресурс к одному
общему `AbortController`. Один rollback — всё убирается.

**Где доступно.** В каждом `PluginContext`, в каждом `ContextKind`.
Плагин получает свой собственный `ScopeApi` instance — он живёт ровно
столько, сколько живёт плагин в данной инжекции.

> `ctx.signal` — алиас на `ctx.scope.signal`. Это просто короче в
> сигнатурах.

## Lifecycle

```
plugin.init(ctx)             ──► scope создан, signal не aborted
  ↓
plugin делает свою работу
  ↓
framework rollback           ──► scope._abort() ──► signal.aborted = true
  ↓                                       ↓
  └─► cleanup-fn из init                  └─► ВСЕ helper'ы:
                                              clearTimeout(id)
                                              removeEventListener
                                              fetch отменяется
                                              observer.disconnect()
                                              promise rejects
                                              ...
```

Все хелперы построены на одном паттерне:

1. На входе — проверка `if (signal.aborted) return ...` (fast-path no-op).
2. Резервирование ресурса (`setTimeout`, `addEventListener`, `observe`, ...).
3. `signal.addEventListener('abort', () => cleanup(), { once: true })` —
   привязка cleanup'а к scope-abort'у.

Что это значит для плагина:

- **Auto-cleanup.** На rollback'е плагин ничего не должен размонтировать
  ВРУЧНУЮ, если он использовал scope-хелперы. Cleanup-fn из init
  отдельно — для DOM-узлов, которые плагин вставил руками.
- **Post-abort calls are silent.** Вызов `scope.setTimeout` уже после
  abort'а — возвращает `-1`, `setInterval` — `-1`, `fetch` — отклоняется
  с AbortError, `observer` — сразу `.disconnect()`. Никаких throw'ев.

## `scope.signal: AbortSignal`

```ts
ctx.scope.signal.addEventListener('abort', () => {
  // ... ваш собственный cleanup, не привязанный к хелперам.
});
```

`AbortSignal` для текущей инжекции. Передавайте куда угодно, что
нативно принимает `signal`:

```ts
fetch(url, { signal: ctx.scope.signal });
document.addEventListener('keydown', onKey, { signal: ctx.scope.signal });
new EventSource(url);  // не принимает signal — используйте abortable / listen
```

> **Не путайте с `ctx.signal`** — оба указывают на тот же
> `AbortController.signal`. Используйте короче.

## `scope.setTimeout(cb, ms): number`

Auto-clearing setTimeout. Возвращает handle для `clearTimeout`.

```ts
const id = ctx.scope.setTimeout(() => {
  ctx.log.info('5 seconds passed');
}, 5_000);
// id можно отменить вручную:
// ctx.scope.clearTimeout(id);
```

**Гарантия:** на rollback'е таймер автоматически отменяется. Если
плагин не делает ничего сложного — просто пиши `scope.setTimeout` и
не думай про cleanup.

**После abort'а:** `setTimeout` возвращает `-1` (валидный для
`clearTimeout` — он молча no-op'ит). НЕ сравнивайте id == -1 в коде —
используйте `signal.aborted` для проверки состояния scope.

## `scope.setInterval(cb, ms): number`

Auto-clearing setInterval. Тот же контракт, что и `setTimeout`:

```ts
ctx.scope.setInterval(() => {
  ctx.log.debug('tick');
}, 1_000);
```

Возвращает `-1` если scope уже aborted. Cleanup автоматический.

## `scope.clearTimeout(id) / scope.clearInterval(id)`

Pass-through к `window.clearTimeout`/`clearInterval`. Удобно, чтобы в
файле было консистентно — без переключения между `ctx.scope.setTimeout`
и глобальным `clearTimeout`:

```ts
const tid = ctx.scope.setTimeout(work, 1_000);
if (immediateBypass) ctx.scope.clearTimeout(tid);
```

Молча no-op'ит на `-1` или неизвестные handle'ы.

## `scope.listen(target, type, handler, opts?)`

`addEventListener` с auto-removal на abort.

```ts
ctx.scope.listen(document, 'click', (ev: MouseEvent) => {
  ctx.log.info('click', { x: ev.clientX, y: ev.clientY });
});

ctx.scope.listen(window, 'resize', () => {
  // ...
}, { passive: true });
```

Подкапотом — `target.addEventListener(type, handler, { ...opts, signal })`.
Браузер сам снимет listener'а при abort'е (это поведение addEventListener
по спецификации).

**Type-safety:** generic `<T extends Event>` — это ergonomics для
handler-сигнатуры, **не** runtime-check. `listen<MessageEvent>(document,
'click', cb)` скомпилируется, но cb получит MouseEvent, и `ev.data`
будет undefined. Тот же trust contract, что у нативного
addEventListener — caller отвечает за соответствие T и type'у.

`opts` не принимает `signal` (фреймворк его сам прокидывает) — он
исключён через `Omit<AddEventListenerOptions, 'signal'>`. Можно
передавать `once`, `passive`, `capture`.

> Альтернатива: передайте `ctx.signal` напрямую в нативный
> addEventListener. Это эквивалентно `scope.listen`, просто чуть
> длиннее: `document.addEventListener('click', cb, { signal: ctx.signal })`.

## `scope.fetch(input, init?)`

`fetch`, отменяющийся на rollback'е.

```ts
const res = await ctx.scope.fetch('/api/data');
if (res.ok) {
  const data = await res.json();
  // ...
}
```

**Если caller передаёт собственный `signal`** — он композируется со
scope-signal'ом через `AbortSignal.any`. Любой из двух abort'ит запрос:

```ts
const ac = new AbortController();
await ctx.scope.fetch(url, { signal: ac.signal });
// Отменится либо когда ac.abort() (caller cancel), либо когда
// scope.signal (framework rollback).
```

**Если scope уже aborted** — fetch reject'ит сразу с AbortError, никакого
сетевого запроса не происходит.

> CEF/Chromium 124+ требуется для `AbortSignal.any`. Steam CEF 126+ — OK.

## `scope.abortable<T>(p)`

Оборачивает Promise так, что его `.then`-цепочка bail'ит на abort.

```ts
const data = await ctx.scope.abortable(
  legacyApi.loadDataReturningPromise()
);
```

**Важно:** сам underlying Promise продолжает работать в background'е —
`abortable` лишь **отписывает** scope от его resolution'а. Если legacy
API не умеет в `signal` — alternatives:

1. Прокинуть `signal` руками внутрь legacy-API (если он принимает).
2. `scope.abortable(p)` — resolution promise'а отписывается от scope, но
   underlying-работа продолжает выполняться.
3. Запустить legacy-API в отдельном контексте и не дожидаться его.

**Fast-path:** если scope уже aborted — abortable reject'ит синхронно с
`DOMException('Aborted', 'AbortError')`. Pending operation `p` остаётся
не слушаемой.

## `scope.observer(o)`

Регистрирует объект с методом `disconnect()` для авто-disconnect'а на
abort. Возвращает тот же объект (chain-friendly):

```ts
const mo = ctx.scope.observer(new MutationObserver((mutations) => {
  for (const m of mutations) ctx.log.debug('mutation', { type: m.type });
}));
mo.observe(document.body, { childList: true, subtree: true });
```

Работает с любым `{ disconnect(): void }`:

- `MutationObserver`
- `IntersectionObserver`
- `PerformanceObserver`
- `ResizeObserver`
- кастомные wrapper'ы (`{ disconnect: () => myCleanup() }`)

**Если scope уже aborted** — observer сразу же `.disconnect()`'ится, и
поэтому даже если caller за ним позовёт `.observe(...)`, observer уже
мёртв (это контракт DOM-observer'ов — disconnected observer не
оповещает).

## Что **не** делать

### Не используйте глобальные таймеры/listener'ы

`window.setInterval`, `document.addEventListener` без signal'а — leak.
Они переживут rollback и будут крутиться над DOM'ом следующей инжекции:

```ts
// ПЛОХО — таймер переживёт rollback.
window.setInterval(() => sb.steam.getCurrentUser(), 1000);

// ХОРОШО — auto-cleanup.
ctx.scope.setInterval(() => sb.steam.getCurrentUser(), 1000);
```

### Не игнорируйте post-abort вызовы

После `scope.signal.aborted === true` все scope-helper'ы становятся
no-op'ами. Но **ваш собственный код** не знает об этом — async-цепочки
дальше after-fetch могут продолжать делать DOM-операции:

```ts
const res = await ctx.scope.fetch(url);          // прерывается на rollback
const data = await res.json();
renderInto(document.body, data);                 // ВЫПОЛНИТСЯ если await прошёл
```

После каждого `await` проверяйте `ctx.signal.aborted`:

```ts
const res = await ctx.scope.fetch(url);
if (ctx.signal.aborted) return;                  // rollback — bail
const data = await res.json();
if (ctx.signal.aborted) return;
renderInto(document.body, data);
```

### Не передавайте scope в `attachPopup`/`addHeaderButton` опции

UI-API'и НЕ принимают `signal` в опциях. Их cleanup — через handle'ы:
`btn.remove()`, `popup.destroy()`. Если вам нужно скоординировать UI-
teardown с rollback'ом — навесьте `signal.addEventListener('abort', ...)`:

```ts
const btn = ctx.sb.ui.addHeaderButton({ id: 'x', label: 'X', onClick: () => {} });
ctx.signal.addEventListener('abort', () => btn.remove(), { once: true });
```

Или просто верните cleanup из init — фреймворк сам вызовет его на rollback'е.

### Не используйте scope для НЕ async-ресурсов

DOM-узлы, переменные, обычные объекты — не требуют scope. Их cleanup —
обычная функция cleanup из `init`'а:

```ts
init(ctx) {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return () => node.remove();
}
```

## Примеры

### Таймер + listener + fetch — всё в одном init'е

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-scope',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Scope helpers demo',
  contextKinds: [ContextKind.Main],
  capabilities: [],
  async init(ctx: PluginContext): Promise<void> {
    // Таймер — auto-clear на rollback.
    ctx.scope.setInterval(() => {
      ctx.log.debug('tick');
    }, 1_000);

    // Listener — auto-remove на rollback.
    ctx.scope.listen(document, 'visibilitychange', () => {
      ctx.log.info('visibility', { hidden: document.hidden });
    });

    // Fetch — auto-abort на rollback.
    try {
      const res = await ctx.scope.fetch('https://example.com/api/data');
      if (ctx.signal.aborted) return;
      const data = await res.json();
      ctx.log.info('got data', { fields: Object.keys(data as object) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;     // rollback, не ошибка
      ctx.log.warn('fetch failed', { err: String(e) });
    }
  },
});
```

### MutationObserver через `observer`

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-observer',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Observer demo',
  contextKinds: [ContextKind.Web],
  capabilities: [],
  init(ctx: PluginContext): void {
    const mo = ctx.scope.observer(new MutationObserver(() => {
      const node = document.querySelector('.game_area_purchase');
      if (node) ctx.log.info('purchase block found');
    }));
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Никакого ручного disconnect'а — scope автоматически вызовет его
    // на rollback'е.
  },
});
```

### Legacy promise через `abortable`

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

function legacyLoad(): Promise<{ count: number }> {
  // Сторонний API без поддержки signal.
  return new Promise((resolve) => setTimeout(() => resolve({ count: 42 }), 5000));
}

sb.plugins.register({
  id: 'demo-abortable',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Abortable demo',
  contextKinds: [ContextKind.Main],
  capabilities: [],
  async init(ctx: PluginContext): Promise<void> {
    try {
      const data = await ctx.scope.abortable(legacyLoad());
      ctx.log.info('legacy data', { count: data.count });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;     // rollback — bail
      ctx.log.warn('legacy failed', { err: String(e) });
    }
  },
});
```

### Композиция scope-signal'а с caller-signal'ом в fetch

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-fetch-compose',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Fetch compose demo',
  contextKinds: [ContextKind.Main],
  capabilities: [],
  async init(ctx: PluginContext): Promise<void> {
    const ac = new AbortController();
    // Тайм-аут пользователя 3 секунды.
    ctx.scope.setTimeout(() => ac.abort(), 3_000);

    try {
      const res = await ctx.scope.fetch('https://example.com/slow',
        { signal: ac.signal });
      if (ctx.signal.aborted) return;
      ctx.log.info('status', { ok: res.ok });
    } catch (e) {
      // AbortError может быть от любого из:
      //   - user-timer (ac.abort()) — пройдено 3с
      //   - rollback (ctx.scope.signal) — framework выпилен
      if ((e as Error).name === 'AbortError') return;
      ctx.log.warn('fetch failed', { err: String(e) });
    }
  },
});
```

## See also

- [`./capabilities.md`](./capabilities.md) — scope доступен ВСЕМ плагинам,
  не gated.
- [`./lifecycle.md`](./lifecycle.md) — когда `scope.signal` aborts (на
  rollback'е).
- [`./pages-api.md`](./pages-api.md) — `PageContext.signal` композирует
  scope-signal с per-mount signal'ом через `AbortSignal.any`.
- `framework/README.md § sb.scope` — internal-механика
  AbortController-цикла.
