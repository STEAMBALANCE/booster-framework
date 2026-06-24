# Pages API

`ctx.sb.pages.*` — URL-matched page-router. Capability —
`Capability.Pages` (гейтится: модуль доступен в `ctx.sb` только если
плагин запросил `Capability.Pages` в `capabilities[]`). Источник истины —
интерфейсы `PagesApi` / `PageMatch` / `PageContext` / `PageHandle` в
`booster-framework/src/api/api-types.ts` + реализация в
`booster-framework/src/api/pages.ts`.

```ts
interface PagesApi {
  register(opts: {
    name: string;
    match: PageMatch;
    mount(ctx: PageContext): void | (() => void) | Promise<void | (() => void)>;
  }): PageHandle;
}

interface PageMatch {
  url: RegExp | ((u: URL) => boolean);
}

interface PageContext {
  readonly url: URL;
  readonly signal: AbortSignal;
}

interface PageHandle {
  unregister(): void;
}
```

**Зачем нужен.** Многие фичи в `ContextKind.Web` (Steam store / community /
help) обязаны жить ровно на одной странице — например `booster-addfunds`
показывает строку «Пополнить кошелёк» только на
`/steamaccount/addfunds`. Без роутера плагину пришлось бы вручную
слушать `pushState` / `popstate` / `hashchange` и руками монтировать /
размонтировать DOM. `sb.pages.register` инкапсулирует это: декларируете
match, фреймворк сам вызовет `mount` при входе и `unmount` при выходе.

**Где доступно.** Во всех `ContextKind`, но практически полезно прежде
всего в `Web` — там приходится бороться с навигацией по доменам
`store.steampowered.com` / `steamcommunity.com`. В `Main` URL обычно
стабилен (`steam://openurl/.*` оборачивается во вкладки), но
регистрация валидна и там — это полезно для tabbedBrowser-окон.

## `register({ name, match, mount })`

Регистрирует page-mod. Возвращает `PageHandle` с методом `unregister()`.

### Параметры

| Поле       | Тип                                                                                | Required | Описание |
|------------|------------------------------------------------------------------------------------|----------|----------|
| `name`     | `string`                                                                           | да       | Диагностическое имя для логов и реестра. Должно быть уникальным внутри одного плагина — sync throw на дубликат. |
| `match`    | `PageMatch`                                                                        | да       | Условие срабатывания (см. ниже). |
| `mount`    | `(ctx: PageContext) => void \| (() => void) \| Promise<void \| (() => void)>`      | да       | Вызывается при ВХОДЕ на match-страницу. Может вернуть `unmount`-функцию, которая отработает на выходе с match-страницы / rollback'е. Может быть async. |

### Возвращаемое значение

`PageHandle.unregister()` — снимает регистрацию. Если страница сейчас
mounted — `unmount` выполнится **синхронно** (для cleanup-fn из `mount`)
после await pending mount (если он ещё бежит). После unregister'а можно
позвать `register` с тем же `name` снова.

## `PageMatch.url`

Два варианта значения — выбирайте по сложности условия.

### `RegExp`

```ts
ctx.sb.pages.register({
  name: 'addfunds',
  match: { url: /\/steamaccount\/addfunds\/?($|\?|#)/ },
  mount(pageCtx) { /* ... */ },
});
```

Регекса проверяется через `regex.test(urlString)` против **полной строки
URL** (`context.url`, т. е. `location.href`). Удобно для большинства
случаев — путь / query / hash сразу в одной строке.

> Регекса должна быть полной: `/addfunds/` сматчит и
> `/steamaccount/addfunds`, и `/community/profile/addfunds-page`. Если
> важно — добавляйте якоря, например
> `/^https:\/\/store\.steampowered\.com\/steamaccount\/addfunds/`.

### `(u: URL) => boolean`

```ts
ctx.sb.pages.register({
  name: 'app',
  match: {
    url: (u) => u.pathname.startsWith('/app/')
              && u.hostname === 'store.steampowered.com',
  },
  mount(pageCtx) { /* ... */ },
});
```

Предикат получает уже распарсенный `URL` — есть `pathname`, `searchParams`,
`hostname`. Удобно для нетривиальных условий (несколько query-параметров,
hostname-проверка). Если предикат бросает — match считается false (исключение
проглатывается, без записи в лог).

## Reconciliation lifecycle

Реактивный движок построен на трёх состояниях каждой регистрации:

| Текущее состояние | Условие         | Действие |
|-------------------|-----------------|----------|
| `!matched && !active` | URL не подходит, ничего не смонтировано | no-op |
| `matched && !active`  | Зашли на match-страницу | вызвать `mount(ctx)`; сохранить cleanup |
| `matched && active`   | URL изменился внутри match (`/foo/a → /foo/b`) | **no-op** (НЕ re-mount) |
| `!matched && active`  | Ушли с match-страницы | await любой pending mount → `cleanup()` |

Reconcile запускается:

1. **При регистрации** — `register({...})` сразу делает первый проход.
2. **На URL change** — фреймворк подписан на `context.onUrlChange`;
   каждое pushState/replaceState/popstate/hashchange триггерит reconcile.
3. **На scope abort** — `lifecycle.rollbackAll()` синхронно зовёт unmount
   для всех активных регистраций.

> **Внутри match не remount'имся.** Переход `/app/123` → `/app/456` —
> оба URL'а подходят под `/app\//`, поэтому `mount` НЕ вызывается
> повторно. Если фичу нужно перестраивать на каждом sub-URL'е —
> подпишитесь на `sb.context.onUrlChange` внутри mount-функции:
>
> ```ts
> mount(pageCtx) {
>   const unsub = ctx.sb.context.onUrlChange((url) => {
>     // ... перерисовать
>   });
>   return () => unsub();
> }
> ```

## `PageContext`

| Поле       | Тип            | Описание |
|------------|----------------|----------|
| `url`      | `URL`          | Распарсенный URL, который сматчился (snapshot на момент mount). Дальше не реактивен — используйте `sb.context.url` если нужно слежение. |
| `signal`   | `AbortSignal`  | Aborts при ЛЮБОМ из двух: уход со страницы (per-mount `AbortController`), либо framework rollback (общий `scope.signal`). Композиция через `AbortSignal.any`. |

Что делать с `signal`:

```ts
mount(pageCtx) {
  // fetch автоматически отменится при выходе со страницы И при rollback'е:
  fetch('/api/data', { signal: pageCtx.signal })
    .then(/* ... */);

  // addEventListener с auto-removal:
  document.addEventListener('click', onClick, { signal: pageCtx.signal });
}
```

Это идиоматичный паттерн поверх web-стандарта — fetch / addEventListener
поддерживают `signal` нативно, никаких scope-обёрток не нужно.

## Async mount

`mount` может быть `async` или возвращать Promise. Чтобы дождаться DOM-
элементов, fetch'а конфига и т. п.:

```ts
ctx.sb.pages.register({
  name: 'store-app',
  match: { url: /\/app\/\d+/ },
  async mount(pageCtx) {
    await waitForElement('.game_area_purchase', pageCtx.signal);
    if (pageCtx.signal.aborted) return;          // ушли со страницы — bail

    const root = document.createElement('div');
    document.body.appendChild(root);
    return () => root.remove();                  // cleanup на выходе
  },
});
```

### Гарантии при async mount

- **Settle-then-unmount.** Если URL ушёл с match'а пока mount ещё в
  полёте, фреймворк дожидается окончания `mount` и СРАЗУ зовёт его
  cleanup-fn. То есть: mount не «потеряется» в полу-готовом состоянии.
- **Mount throw → no cleanup.** Если mount бросает (или Promise reject'ит),
  фреймворк логирует `nativeWarn('sb.pages mount '<name>' threw')` и
  следующий reconcile не повторит mount до новой смены URL.
- **Re-entry safe.** mount, который сам по себе делает
  `history.replaceState` (= триггерит URL change), не вызывает
  рекурсию — внутренний guard следит.

### Cleanup throw

Cleanup-fn, бросающая исключение, **не** прерывает остальные unmount'ы
(каждый cleanup завёрнут в try/catch). Ошибка логируется как
`sb.pages cleanup threw`.

## `PageHandle.unregister()`

Снимает регистрацию вручную:

```ts
const handle = ctx.sb.pages.register({ name: 'demo', match: { url: /\/x/ }, mount });
// ... позже
handle.unregister();
```

После вызова:

1. Регистрация удаляется из реестра — same-`name` `register` снова доступен.
2. Если страница сейчас mounted — pending mount await'ится, cleanup
   запускается.
3. Внутренний `ctx.signal` файрится (per-mount AbortController abort'ится).

Обычно `unregister` ВЫЗЫВАТЬ НЕ НУЖНО — `scope.signal` (rollback)
автоматически снимает все регистрации. Используйте только если плагину
нужно динамически менять набор страниц (например feature-flag отключён в
runtime).

## Cross-context behaviour

Регистрация — **локальная** в текущем `ContextKind`. Плагин с
`contextKinds: [ContextKind.Main, ContextKind.Web]` будет иметь
ОТДЕЛЬНЫЕ инстансы `sb.pages` в каждом контексте; регистрация в Web
не видна в Main.

Чтобы координировать страницы кросс-target — используйте
[`./bus-api.md`](./bus-api.md) (например `booster-addfunds` публикует
`booster-addfunds.topup-requested` из Web, а `booster-checkout` подписывается из
Main).

## Полный пример: booster-addfunds на /steamaccount/addfunds

Реальный плагин из `booster-plugins/packages/booster-addfunds/`. Регистрирует одну
page-mod, которая срабатывает только на странице пополнения кошелька
Steam:

```ts
import {
  ContextKind, Capability,
  type PluginContext, type PageContext,
} from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-pages',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'AddFunds page-mod demo',
  contextKinds: [ContextKind.Web],
  capabilities: [Capability.Pages, Capability.Bus],
  init(ctx: PluginContext): void {
    ctx.sb.pages.register({
      name: 'addfunds',
      // Матчит /steamaccount/addfunds + /steamaccount/addfunds/
      // + ?query + #hash. Не матчит /app/123 или /steamaccount/.
      match: { url: /\/steamaccount\/addfunds\/?($|\?|#)/ },
      async mount(pageCtx: PageContext): Promise<() => void> {
        // 1. Дождаться DOM ready (legacy server-rendered страница).
        if (document.readyState === 'loading') {
          await new Promise<void>((resolve) => {
            document.addEventListener('DOMContentLoaded', () => resolve(),
              { once: true, signal: pageCtx.signal });
          });
        }
        if (pageCtx.signal.aborted) return () => {};

        // 2. Найти контейнер, вставить нашу строку.
        const grid = document.querySelector<HTMLElement>('.game_area_purchase');
        if (!grid) return () => {};

        const row = document.createElement('div');
        row.id = 'booster-addfunds-row';
        row.textContent = 'Пополнить';                        // strings-allow-cyrillic
        grid.parentElement?.insertBefore(row, grid);
        const prevDisplay = grid.style.display;
        grid.style.display = 'none';

        // 3. Cleanup на выходе со страницы / rollback.
        return () => {
          try { row.remove(); } catch { /* already gone */ }
          grid.style.display = prevDisplay;
        };
      },
    });
  },
});
```

## Множественные регистрации

Один плагин может зарегистрировать несколько page-mod'ов с разными
`name` и `match`:

```ts
import {
  ContextKind, Capability,
  type PluginContext, type PageContext,
} from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-pages-multi',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Multi-page demo',
  contextKinds: [ContextKind.Web],
  capabilities: [Capability.Pages],
  init(ctx: PluginContext): void {
    ctx.sb.pages.register({
      name: 'app-page',
      match: { url: /\/app\/\d+/ },
      mount(_pc: PageContext): () => void {
        ctx.log.info('on app page');
        return () => ctx.log.info('left app page');
      },
    });

    ctx.sb.pages.register({
      name: 'community-profile',
      match: {
        url: (u) => u.hostname === 'steamcommunity.com'
                 && u.pathname.startsWith('/id/'),
      },
      mount(_pc: PageContext): () => void {
        ctx.log.info('on community profile');
        return () => {};
      },
    });
  },
});
```

## Что **не** делать

### Не подписывайтесь на onUrlChange руками вместо pages

Если фича привязана к URL pattern — используйте `sb.pages.register`. Сам
паттерн «слушай URL, диффай против match'а, монтируй/размонтируй» уже
встроен и отлажен (reconciliation guard + settle-then-unmount + cleanup
throw isolation). Ручная реализация ловит граничные случаи плохо.

### Не держите DOM-ссылки после cleanup'а

Cleanup-fn — точка истины «всё, страница для нас закрыта». Любая
переменная, держащая DOM-узел или fetch-controller, должна быть
released там же. Иначе следующий mount'е увидит stale-handle.

### Не делайте mount'ом долгую работу без проверки `signal.aborted`

Если в mount'е длинная цепочка `await` — проверяйте `pageCtx.signal.aborted`
после каждого await'а:

```ts
async mount(pageCtx) {
  const data = await fetch('/api', { signal: pageCtx.signal }).then(r => r.json());
  if (pageCtx.signal.aborted) return;  // ушли со страницы — bail
  renderInto(document.body, data);
  // ...
}
```

`fetch` сам отменится по signal'у, но `.then(r => r.json())` не — а
дальнейший `renderInto` после abort'а вставит DOM в страницу, где он
уже не нужен.

### Не регистрируйте одно и то же имя дважды

`register` бросает sync:

```
sb.pages.register: duplicate name 'addfunds'
```

Если нужно «зарегистрировать заново» — сначала `handle.unregister()`,
потом `register` (тогда same-name проходит).

## Cleanup на rollback

Подписки автоматически снимаются на `lifecycle.rollbackAll()` (framework
abort → `scope.signal.dispatchEvent('abort')` → unmount всех активных
регистраций + clear реестра). Подписка на `context.onUrlChange` тоже
снимается тем же сигналом.

## See also

- [`./capabilities.md`](./capabilities.md) — `Capability.Pages`
  (capability-gated; запрашивается в `capabilities[]`).
- [`./scope-api.md`](./scope-api.md) — `ctx.scope.fetch` / addEventListener
  внутри mount'а (composable с `pageCtx.signal`).
- [`./bus-api.md`](./bus-api.md) — кросс-target координация между page-mod'ом
  и Main-shell плагином (паттерн addfunds → checkout).
- [`./lifecycle.md`](./lifecycle.md) — авто-cleanup регистраций на
  rollback.
- `framework/README.md § sb.pages` — internal-механика reconcile-цикла.
