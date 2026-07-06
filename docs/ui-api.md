# UI API

`ctx.sb.ui.*` — DOM-операции и native-окна Steam'а: кнопка в шапке,
attached popup (dropdown), Steam-native окно с iframe и tabbed external
URL. Гейтится под `Capability.Ui` — без выданного и запрошенного гранта
`ctx.sb.ui === undefined` (см. [`./capabilities.md`](./capabilities.md)).
Источник истины — интерфейс `UiApi` в `booster-framework/src/api/api-types.ts`
+ `booster-framework/src/api/ui.ts`.

```ts
interface UiApi {
  addHeaderButton(opts: HeaderButtonOptions): HeaderButtonHandle;
  attachPopup(opts: AttachedPopupOptions): Promise<AttachedPopupHandle>;
  openWindow(opts: OpenWindowOptions): Promise<OpenWindowHandle>;
  openExternalWindow(opts: OpenExternalWindowOptions): Promise<OpenExternalWindowHandle>;
  addMenuItem(opts: MenuItemOptions): Promise<MenuItemHandle>;
  addStoreNavButton(opts: StoreNavButtonOptions): StoreNavButtonHandle;
  addSuperNavButton(opts: SuperNavButtonOptions): SuperNavButtonHandle;
}
```

**Где доступно.** `sb.ui` имеет смысл только там, где есть DOM:
`ContextKind.Main`, `ContextKind.TabbedBrowser`, `ContextKind.Web`. В
`ContextKind.Shared` (SharedJSContext) DOM отсутствует — `addHeaderButton`
не находит toolbar, `attachPopup` / `openWindow` не имеют визуального
эффекта. Регистрируйте UI-плагины ровно в тех kinds, которые их
используют.

**Cleanup.** Каждая операция регистрируется в framework registry; на
`lifecycle.rollbackAll()` (re-injection, hot-reload, panic-stop) handle
сам себя снимает. Явный `handle.remove()` / `handle.destroy()` /
`handle.close()` нужен только когда плагин хочет удалить UI до конца
сессии.

## `addHeaderButton(opts)` — кнопка в шапке Steam

Вставляет div-кнопку в toolbar главного окна, имитируя стиль штатных
элементов (Магазин, Библиотека, bell). Возвращает синхронный handle
сразу — placement делается asynchronously после `waitForToolbar()`.

### `HeaderButtonOptions`

| Поле        | Тип                                | Default          | Описание |
|-------------|------------------------------------|------------------|----------|
| `id`        | `string`                           | —                | Идентификатор DOM-элемента. Должен быть уникальным в шапке. |
| `label`     | `string`                           | —                | Видимый текст. |
| `icon?`     | `string`                           | —                | Inline `data:image/...` ИЛИ HTML-фрагмент (`<svg ...>`). **innerHTML** для SVG — передавайте только build-time константы. |
| `tooltip?`  | `string`                           | —                | Steam-style плавающая подсказка (не Windows native). |
| `placement?`| `HeaderButtonPlacement`            | `before-profile` | `'before-profile' \| 'before-notifications' \| 'after-profile' \| 'end'`. |
| `variant?`  | `'default' \| 'brand'`             | `'default'`      | `'brand'` — зелёная CTA (`#34a37b`, uppercase). |
| `onClick?`  | `(ctx: { rect: DOMRect }) => void \| Promise<void>` | — | Обработчик клика. **Re-entry guard:** на async — повторные клики игнорируются до конца промиса. |
| `togglePopup?` | `AttachedPopupHandle`           | —                | Альтернатива `onClick`: клик дёргает `popup.toggle({x, y})` с авто-позиционированием. |

**Mutex.** `onClick` и `togglePopup` — взаимоисключающие. Если оба заданы
или оба пропущены — `addHeaderButton` бросает sync.

```ts
throw new Error(
  'addHeaderButton: provide exactly one of onClick or togglePopup ...'
);
```

### `HeaderButtonHandle`

```ts
interface HeaderButtonHandle {
  remove(): void;
  setLabel(s: string): void;
  setEnabled(on: boolean): void;
  getRect(): DOMRect;  // live CSS-пиксели относительно main-shell viewport
}
```

- `setEnabled(false)` ставит `aria-disabled="true"`, `tabindex="-1"`,
  `pointerEvents: none` — кнопка остаётся видимой, но не фокусируема и
  не кликабельна.
- `getRect()` всегда читает живые координаты; используется при ручном
  показе attached popup.

### Пример: простая кнопка

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-button',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Header button demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  init(ctx: PluginContext): () => void {
    const btn = ctx.sb.ui.addHeaderButton({
      id: 'demo-btn',
      label: 'Привет',
      tooltip: 'Поздороваться',
      variant: 'brand',
      onClick: () => ctx.log.info('clicked'),
    });
    return () => btn.remove();
  },
});
```

## `attachPopup(opts)` — pre-allocated native dropdown

Аллоцирует **один** native popup window на старте и переключает его
видимость по требованию. Используется booster-checkout для дропдауна
пополнения. Resolves когда relay создал и спрятал окно.

> Это **не** `window.open`. Окно создаётся native-стороной Steam
> (CEFSharp tabbed-helper), origin = опенера, BroadcastChannel между
> главным окном и popup'ом — работает.

### `AttachedPopupOptions`

| Поле       | Тип        | Default | Описание |
|------------|------------|---------|----------|
| `id`       | `string`   | —       | `[a-zA-Z0-9_-]{1,64}`. Используется как native window name + BC ключ. |
| `html`     | `string`   | —       | Inline HTML, вписывается в popup через `document.write`. Cap `POPUP_HTML_MAX_BYTES`. |
| `width`    | `number`   | —       | Клампится `max(40, min(width, 1200))`. |
| `height?`  | `number`   | `200`   | Клампится `max(40, min(height, 800))`. |
| `hideOnBlur?` | `boolean` | `true` | Если `true` — relay скрывает popup при потере фокуса (Steam-native поведение dropdown'а). |

#### `eCreationFlags` как named booleans

Defaults подобраны под Steam-native dropdown (флаг-сет 4538634).
Голый `attachPopup({id, html, width})` сразу даёт правильный look.

| Поле                  | Default | Что делает |
|-----------------------|---------|------------|
| `alwaysOnTop?`        | `false` | Поверх главного окна Steam. |
| `nativeBorder?`       | `true`  | CEF 1px border (bit 65536). |
| `noTaskbarIcon?`      | `true`  | Спрятать иконку из panel'а Windows. |
| `noWindowShadow?`     | `true`  | Отключить тень Windows. |
| `noRoundedCorners?`   | `true`  | Без скругления Win11. |
| `composited?`         | `true`  | GPU compositing. |
| `transparentParent?`  | `true`  | Transparent parent linkage. |
| `overrideRedirect?`   | `false` | X11 OverrideRedirect — на Windows no-op. |

### `AttachedPopupHandle`

```ts
interface AttachedPopupHandle {
  readonly width: number;     // эффективный (после clamping)
  readonly height: number;    // эффективный

  toggle(at: { x: number; y: number }): void;  // с 250мс gate'ом
  show(at: { x: number; y: number }): void;    // RAW, без gate
  hide(): void;
  postMessage(data: unknown): void;
  on(event: 'message' | 'show' | 'hide',
     cb: (data?: unknown) => void): () => void;
  isVisible(): boolean;
  destroy(): void;
}
```

- **`width` / `height`** — реальные размеры окна **после** clamping,
  не raw input. Полезно для compute screen-coords (см. `togglePopup`).
- **`toggle` vs `show`/`hide`**. `toggle` имеет **250мс gate** на relay-
  стороне: если предыдущий state-change был < 250мс назад — вызов
  consume-ится без эффекта. Это нужно для button-click debounce. `show`
  / `hide` — RAW, gate обходят.
- **`isVisible()`** отражает last-acked состояние (после relay-echo'а),
  не текущий native-state. Может коротко отставать от `show()`.

### События: pattern `handle.on('hide', cb)`

`AttachedPopupOptions` **не имеет `onClose` field'а**. Подписка на
закрытие — через `handle.on('hide', cb)`. `on` возвращает unsubscribe.

```ts
const popup = await ctx.sb.ui.attachPopup({
  id: 'my_popup',
  html: '<h1>Hi</h1>',
  width: 360,
});

const offHide = popup.on('hide', () => {
  ctx.log.info('popup закрылся');
});
const offShow = popup.on('show', () => {
  ctx.log.info('popup открылся');
});
const offMsg  = popup.on('message', (data) => {
  ctx.log.info('postMessage из popup', { data });
});

// При желании — снять подписку явно (иначе снимется через scope abort):
ctx.signal.addEventListener('abort', () => {
  offHide(); offShow(); offMsg();
}, { once: true });
```

### Пример: header button с привязанным popup

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-popup',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Popup demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  async init(ctx: PluginContext): Promise<() => void> {
    const popup = await ctx.sb.ui.attachPopup({
      id: 'demo_popup',
      html: '<body style="padding:12px;color:#fff;background:#1b1d23">'
          + '<b>Привет!</b></body>',
      width: 320,
      height: 200,
    });

    const offHide = popup.on('hide', () => ctx.log.info('popup hidden'));

    const btn = ctx.sb.ui.addHeaderButton({
      id: 'demo-popup-btn',
      label: 'Меню',
      // togglePopup — клик авто-позиционирует popup под кнопкой.
      togglePopup: popup,
    });

    return () => {
      offHide();
      btn.remove();
      popup.destroy();
    };
  },
});
```

## `openWindow(opts)` — Steam-native окно с iframe

Steam-native modal: native title bar (через wrapper HTML), close button,
iframe внутрь которого встаёт URL или inline-HTML. Resolves когда relay
создал окно. См. `framework/README.md § sb.ui.openWindow` для деталей.

### `OpenWindowOptions`

| Поле               | Тип       | Default     | Описание |
|--------------------|-----------|-------------|----------|
| `id`               | `string`  | —           | `[a-zA-Z0-9_-]{1,64}`. |
| `title`            | `string`  | —           | Рендерится в HTML-title bar. **Required.** |
| `url?`             | `string`  | —           | Mutex с `html`. https-only, sync throw на unsafe. |
| `html?`            | `string`  | —           | Mutex с `url`. Cap `OPEN_WINDOW_HTML_MAX_BYTES`. |
| `width`            | `number`  | —           | > 0. |
| `height`           | `number`  | —           | > 0. |
| `minWidth?`        | `number`  | `320`       | Floor `200`. |
| `minHeight?`       | `number`  | `240`       | Floor `150`. |
| `resizable?`       | `boolean` | `false`     | `false` матчит модал Steam'а 1:1 (без DWM restore-анимации). |
| `noTaskbarIcon?`   | `boolean` | `false`     | Скрыть из taskbar. |
| `alwaysOnTop?`     | `boolean` | `false`     | |
| `composited?`      | `boolean` | `false`     | GPU compositing. Включать только если эмбед его требует — иначе ломает center_on_window. |
| `centerOnMain?`    | `boolean` | `true`      | Центрировать поверх главного окна. |
| `iframeBackground?`| `string`  | `'#fff'`    | CSS-color вокруг iframe (видно если контент уже окна). Caller-trusted, без санитайзинга. |
| `embedOrigins?`    | `string[]`| `[]`        | Доп. https-origin'ы (помимо origin стартового `url`) для embed-рукопожатия при навигации iframe. Relay валидирует; ≤8. Только url-режим. См. [`embed-bridge.md`](./embed-bridge.md). |

**Sync validation** (бросает до BC-вызова): `id` regex, mutex `url`/`html`,
непустой `title`, `width/height > 0`, `url` через `isUrlSafeForNavigation`
(https-only, без userinfo, без явного port'а), cap на размер `html`.

### `OpenWindowHandle`

```ts
interface OpenWindowHandle {
  readonly id: string;
  readonly width: number;        // эффективный
  readonly height: number;       // эффективный
  show(): void;
  hide(): void;
  close(): void;
  bringToFront(): void;
  setTitle(s: string): void;
  isVisible(): boolean;
  postMessage(data: unknown): void;
  on(event: 'show' | 'hide' | 'close' | 'message',
     cb: (data?: unknown) => void): () => void;
}
```

- **`postMessage` в url-режиме** доставляет payload в cross-origin iframe
  через `window.postMessage` (мост в обёртке). Слать только после получения
  `sb:ready` от страницы; payload ≤ 16 КБ, иначе drop. Подробнее —
  [`embed-bridge.md`](./embed-bridge.md).
- **`close()`** идемпотентен: повторный вызов — no-op.
- **`on('close', cb)`** — обработчик user-X-close. Подписка снимается
  автоматически на framework rollback.

### Пример: окно с inline-HTML

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-window',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Window demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  async init(ctx: PluginContext): Promise<() => void> {
    const win = await ctx.sb.ui.openWindow({
      id: 'demo_win',
      title: 'Информация',
      html: '<h1 style="font-family:sans-serif">Привет из openWindow</h1>',
      width: 500,
      height: 320,
      iframeBackground: '#1b1d23',
    });

    const offClose = win.on('close', () => ctx.log.info('window closed'));
    return () => { offClose(); win.close(); };
  },
});
```

## `openExternalWindow(opts)` — Steam Tabbed Browser

Открывает external URL в Steam Tabbed Browser (тот, в котором живут
"Новости" и встроенные payment-страницы). Удобно для платёжных
редиректов: Steam сам ведёт TLS, история переходов остаётся в одном
окне, title-bar управляется через `Page.addScriptToEvaluateOnNewDocument`.

### `OpenExternalWindowOptions`

| Поле            | Тип               | Default | Описание |
|-----------------|-------------------|---------|----------|
| `id`            | `string`          | —       | `[a-zA-Z0-9_-]{1,64}`. Повторный `openExternalWindow` с тем же `id` при живом окне — отвергается relay'ем. |
| `url`           | `string`          | —       | https-only, ASCII-strict, без userinfo, без явного port'а, длина ≤ 2048. |
| `title?`        | `string`          | —       | Заголовок для React-title-bar Steam'а. 1..200 UTF-16 code units. Override активен на все redirect-цели. |
| `taskbarTitle?` | `string \| null`  | —       | Заголовок для Windows native title-bar / taskbar. **`null`** — explicit opt-out, Steam-default восстанавливается. **`undefined`** — fallback на `title`. |

### `OpenExternalWindowHandle`

```ts
interface OpenExternalWindowHandle {
  readonly id: string;
  setUrl(url: string): void;            // атомарная замена (Add+Remove)
  close(): void;                        // закрыть вкладку
  on(event: 'close', cb: () => void): () => void;
}
```

- `setUrl` бросает sync на invalid URL, silent no-op если handle уже
  закрыт.
- `on('close', cb)` срабатывает **один раз** (закрытие вкладки или окна).

### Пример: payment redirect

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-ext',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'External window demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  async init(ctx: PluginContext): Promise<() => void> {
    const win = await ctx.sb.ui.openExternalWindow({
      id: 'demo_payment',
      url: 'https://example.com/checkout/12345',
      title: 'Оплата',
      taskbarTitle: 'Оплата · steambooster',
    });

    const offClose = win.on('close', () => ctx.log.info('checkout window closed'));
    return () => { offClose(); win.close(); };
  },
});
```

## `addMenuItem(opts)` — пункт в верхней навигации Steam

Вставляет собственный пункт в один из top-nav dropdown'ов десктоп-клиента
Steam (МАГАЗИН / БИБЛИОТЕКА / СООБЩЕСТВО / профиль). Эти dropdown'ы —
context-menu popup'ы, живущие в SharedJSContext (`g_PopupManager`), поэтому
DOM-работу выполняет relay: `addMenuItem` только передаёт намерение, а relay
инжектит пункт, удерживает его живым через open/close меню и re-injection
фреймворка, и по клику навигирует **главное окно** Steam на `opts.url`
(`MainWindowBrowserManager.LoadURL`).

Вызывать из контекста с bridge/relay — обычно `ContextKind.Main` (шелл
клиента живёт всю сессию, поэтому пункт присутствует всегда, независимо от
открытой страницы).

### `MenuItemOptions`

| Поле         | Тип                                | Default   | Описание |
|--------------|------------------------------------|-----------|----------|
| `id`         | `string`                           | —         | `[a-zA-Z0-9_-]{1,64}`. Авто-префиксуется `<pluginId>__`; служит DOM-id, `<style>`-селектором и ключом маршрутизации. |
| `menu`       | `'store' \| 'library' \| 'community' \| 'profile'` | — | Целевой supernav-dropdown. |
| `label`      | `string`                           | —         | Текст пункта (через `textContent`). ≤ 120 символов. |
| `icon?`      | `string`                           | —         | Inline-SVG или `data:image/*`. Ставится справа от текста. SVG с `fill="currentColor"` наследует цвет текста (перекрашивается на hover). **Санитайзится relay'ем** (allowlist тегов/атрибутов SVG; `on*`/script/внешние ссылки вырезаются) — в отличие от `HeaderButtonOptions.icon`, т.к. инжект идёт в привилегированный SharedJSContext. |
| `url`        | `string`                           | —         | https-only, без userinfo/порта, ≤ 2048. Открывается в главном окне Steam по клику. |
| `variant?`   | `'brand' \| 'default'`             | `'default'` | `'brand'` — фирменная подача SteamBalance (idle-фон `#34A37B33`, текст+иконка `#93E0AD`; hover возвращает нативный вид пункта Steam). `'default'` — как обычный пункт Steam. |
| `placement?` | `'top' \| 'bottom'`                | `'top'`   | Позиция в списке меню. |

### `MenuItemHandle`

```ts
interface MenuItemHandle {
  remove(): void;   // убрать пункт; fire-and-forget
}
```

- `addMenuItem` **резолвится когда relay зарегистрировал намерение**, а не
  когда DOM-узел создан (меню может быть закрыто в момент вызова).
- Пункт снимается автоматически на `lifecycle.rollbackAll()` (registry
  undo). Явный `handle.remove()` нужен только для досрочного удаления.

### Пример: пункт «Каталог игр» в меню МАГАЗИН

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-menu',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Menu item demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  async init(ctx: PluginContext): Promise<() => void> {
    const item = await ctx.sb.ui.addMenuItem({
      id: 'catalog',
      menu: 'store',
      label: 'Каталог игр',
      icon: '<svg viewBox="0 0 14 12"><path fill="currentColor" d="…"/></svg>',
      url: 'https://example.com/catalog',
      variant: 'brand',
      placement: 'top',
    });
    return () => item.remove();
  },
});
```

## `addStoreNavButton(opts)` — кнопка в верхнем таб-баре магазина Steam

Вставляет постоянную кнопку в строку табов магазина Steam-клиента
(«Просмотр / Рекомендации / Категории / …» — ряд под поиском). В отличие
от `addMenuItem` (SharedJSContext + relay), работает напрямую в DOM
`ContextKind.Web`-страницы, без relay round-trip — поэтому
`addStoreNavButton` **синхронный**: возвращает handle сразу, а не
`Promise`, как `addHeaderButton`.

**Где доступно.** Только `ContextKind.Web` (сама страница магазина).
Регистрируйте плагин с `contextKinds: [ContextKind.Web]`.

### `StoreNavButtonOptions`

| Поле         | Тип                    | Default    | Описание |
|--------------|------------------------|------------|----------|
| `id`         | `string`               | —          | `[a-zA-Z0-9_-]{1,64}` (тот же `MENU_ITEM_ID_RE`, что у `addMenuItem`). DOM-id кнопки; также ключ CSS-селектора `[data-booster-storenav-btn]`. |
| `label`      | `string`               | —          | Текст кнопки через `textContent`. 1..120 символов. |
| `icon?`      | `string`               | —          | Inline-SVG или `data:image/*`, рендерится после текста. SVG **санитайзится** (allowlist тегов/атрибутов) — страница магазина полу-привилегированное origin, а `Capability.Ui` доступен сторонним (`approvedPlugins[]`) плагинам, в отличие от `HeaderButtonOptions.icon`. `data:image/*` идёт в `<img>` без санитайзинга. Cap 16 КБ. |
| `url`        | `string`               | —          | https-only, без userinfo/порта, ≤2048 символов (`isUrlSafeForNavigation`). Цель клика. |
| `variant?`   | `'default' \| 'brand'` | **`'brand'`** | Фирменный зелёный pill (`#34a37b`, 32px, uppercase). Единственный из `sb.ui`-методов, где `'brand'` — default, а не opt-in. |
| `placement?` | `'start' \| 'end'`     | `'start'`  | `'start'` — перед первой вкладкой («Просмотр»); `'end'` — после последней. |

### `StoreNavButtonHandle`

```ts
interface StoreNavButtonHandle {
  remove(): void;
  setLabel(s: string): void;
}
```

- `remove()` останавливает reconcile-loop, отключает `MutationObserver`
  и убирает кнопку из DOM. Также срабатывает автоматически на
  `lifecycle.rollbackAll()`.
- `setLabel(s)` меняет `textContent` лейбла на месте, без пересоздания
  кнопки.

### Durability: структурный якорь, а не CSS-класс

Хэш-класс строки табов меняется при пересборках Steam, а сама строка
перерисовывается React'ом (табы схлопываются в «Прочее» на узких
viewport'ах) — полагаться на класс, текст или геометрию нельзя.
`addStoreNavButton` поэтому ищет строку **структурно**: берёт все
`button[aria-expanded]`, содержащие caret `<svg>`, группирует их по
общему родителю и выбирает группу с наибольшим числом таких кнопок
(тайбрейк — группа, где все кнопки имеют один и тот же `className`). См.
`src/steam-internals/store-nav-selectors.ts::findStoreNav`.

Найдя строку, `addStoreNavButton` держит кнопку живой через два
параллельных механизма:

- **Reconcile-poll** — `reconcile()` вызывается сразу (instant mount,
  если строка уже в DOM на момент вызова), затем каждые **800мс** через
  `setInterval`.
- **`MutationObserver`** на `childList` найденной строки — ловит
  React-перерисовку мгновенно, не дожидаясь следующего тика poll'а.

Оба механизма делают одно и то же: если `row.contains(button)` стало
`false` (Steam выбросил узел при ре-рендере), кнопка вставляется заново
на позицию `placement`.

### Навигация: `location.assign`, а не `MainWindowBrowserManager`

По клику `addStoreNavButton` вызывает `window.location.assign(opts.url)`
в текущей вкладке магазина — **не** `MainWindowBrowserManager.LoadURL`,
как `addMenuItem`. Причина: `addMenuItem` инжектится relay'ем в
привилегированный `SharedJSContext`, откуда `MainWindowBrowserManager`
доступен; `addStoreNavButton` же выполняется прямо в самой странице
магазина (`ContextKind.Web`), у которой нет моста к этому объекту —
единственный доступный способ навигации отсюда — обычный
`location.assign` в той же вкладке.

### Capability и валидация

Требует `Capability.Ui` — без гранта `ctx.sb.ui === undefined` (см.
[`./capabilities.md`](./capabilities.md)). `addStoreNavButton` бросает
**синхронно**, до касания DOM: на невалидный `id`, на пустой или
слишком длинный `label`, на слишком большой `icon`, на небезопасный
`url`.

### Пример: кнопка «Каталог игр» в магазине

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-storenav',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Store nav button demo',
  contextKinds: [ContextKind.Web],
  capabilities: [Capability.Ui],
  init(ctx: PluginContext): () => void {
    const btn = ctx.sb.ui.addStoreNavButton({
      id: 'catalog',
      label: 'Каталог игр',
      icon: '<svg viewBox="0 0 14 12"><path fill="currentColor" d="…"/></svg>',
      url: 'https://example.com/catalog',
      placement: 'start',
    });
    return () => btn.remove();
  },
});
```

## `addSuperNavButton(opts)` — кнопка в супернаве Steam-клиента

Вставляет постоянную кнопку в верхний main-nav ряд Steam-клиента
(«Магазин / Библиотека / Сообщество / `<НИК>`»), сразу **после** таба
`<НИК>` (профиль). Работает напрямую в DOM главной оболочки
(`ContextKind.Main`), без relay round-trip — поэтому `addSuperNavButton`
**синхронный**: возвращает handle сразу. В отличие от `addStoreNavButton`
кнопка **не** навигирует по `url`, а вызывает `onClick`, и несёт на handle
состояния loading / error / enabled.

**Где доступно.** Только `ContextKind.Main` (супернав — часть клиентской
оболочки, не страницы магазина). Регистрируйте плагин с
`contextKinds: [ContextKind.Main]`.

### `SuperNavButtonOptions`

| Поле         | Тип                              | Default            | Описание |
|--------------|----------------------------------|--------------------|----------|
| `id`         | `string`                         | —                  | `[a-zA-Z0-9_-]{1,64}` (`MENU_ITEM_ID_RE`). DOM-id кнопки; также ключ CSS-селектора `[data-booster-supernav-btn]`. Валидируется (throws). |
| `label`      | `string`                         | —                  | Текст кнопки через `textContent` (стиль делает uppercase). 1..120 символов. Валидируется (throws). |
| `icon?`      | `string`                         | —                  | Inline-SVG или `data:image/*`, рендерится рядом с текстом. SVG **санитайзится** (allowlist тегов/атрибутов) — супернав полу-привилегирован, а `Capability.Ui` доступен сторонним (`approvedPlugins[]`) плагинам. `data:image/*` идёт в `<img>`. Cap 16 КБ. |
| `placement?` | `'after-profile' \| 'end'`       | **`'after-profile'`** | `'after-profile'` — сразу после таба `<НИК>`; `'end'` — последним ребёнком ряда. |
| `variant?`   | `'default' \| 'brand'`           | **`'brand'`**      | Фирменный зелёный pill (`#34a37b`, 32px, uppercase). |
| `onClick`    | `(ctx: { rect: DOMRect }) => void \| Promise<void>` | — | Обработчик клика (навигации по `url` нет). Получает живой `DOMRect` кнопки. Повторный клик, пока предыдущий promise не зарезолвился, игнорируется (busy-guard). |

### `SuperNavButtonHandle`

```ts
interface SuperNavButtonHandle {
  remove(): void;
  setLabel(s: string): void;
  setEnabled(on: boolean): void;
  setLoading(on: boolean): void;
  flashError(): void;
  getRect(): DOMRect;
}
```

- `remove()` останавливает reconcile-loop, отключает `MutationObserver`,
  снимает user-snapshot-listener, чистит error-таймер и убирает кнопку из
  DOM. Также срабатывает автоматически на `lifecycle.rollbackAll()`.
- `setLabel(s)` меняет `textContent` лейбла на месте.
- `setEnabled(on)` — `false` ставит `aria-disabled="true"` и глушит клики.
- `setLoading(on)` — показывает спиннер, кнопка читается как disabled и
  игнорирует клики.
- `flashError()` подсвечивает кнопку красным на ~1с и возвращает обычный
  вид.
- `getRect()` — живой `getBoundingClientRect()` кнопки.

### Durability: структурный якорь по имени, а не CSS-класс

Хэш-классы Steam-клиента меняются при пересборках, а супернав
перерисовывается React'ом — полагаться на класс, id или геометрию нельзя.
`addSuperNavButton` ищет таб `<НИК>` **структурно**: сканирует leaf-узлы,
чей точный `textContent` равен **persona-** или **account-имени**
пользователя (оба берутся из `user-snapshot` события общего relay-канала
`sb_cmd`), и поднимается к контейнеру, у которого этот таб соседствует
минимум с двумя другими tab-подобными детьми. `getBoundingClientRect` не
используется (happy-dom возвращает нули). См.
`src/steam-internals/supernav-selectors.ts::findSuperNav`.

Найдя ряд, кнопка держится живой через `MutationObserver` на
`document.documentElement` (мгновенно ловит React-перерисовку) + форс-poll
каждые **800мс** (ground-truth re-validation, self-heal начального
mis-pick). Смена аккаунта (новый `user-snapshot` с другим именем)
триггерит форс-reconcile, и кнопка переезжает в новый ряд.

### Capability и валидация

Требует `Capability.Ui` — без гранта `ctx.sb.ui === undefined` (см.
[`./capabilities.md`](./capabilities.md)). `addSuperNavButton` бросает
**синхронно**, до касания DOM: на невалидный `id`, на пустой или слишком
длинный `label`, на слишком большой `icon`, на не-функцию `onClick`.

### Пример: кнопка «Оцени аккаунт» в супернаве

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-supernav',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Super nav button demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  init(ctx: PluginContext): () => void {
    const btn = ctx.sb.ui.addSuperNavButton({
      id: 'rate',
      label: 'Оцени аккаунт',
      async onClick() {
        btn.setLoading(true);
        try { await doWork(); }
        catch { btn.flashError(); }
        finally { btn.setLoading(false); }
      },
    });
    return () => btn.remove();
  },
});
```

## Кейсы и ограничения

### CSP и `ContextKind.Web`

В `ContextKind.Web` (магазин, community, help) CSP жёстче, чем в
`Main`/`TabbedBrowser`:

- inline-`<style>` блокируется в части доменов — `addHeaderButton`
  использует non-inline стилевой инжект через `ensureToolbarStyles()`,
  это работает; пользовательский inline-CSS в `html` для `openWindow`
  / `attachPopup` живёт уже внутри созданного нами окна (там CSP
  опенера), без ограничений.
- `data:image/*` для `icon` — всегда OK.
- Сторонние URL (`fetch`, `<script src>`) — следует ставить через
  `ctx.scope.fetch` и проверять connect-src в DevTools, если плагин
  встроен в чужой документ.

### Re-injection / hot-reload

Все handle'ы автоматически snap'аются на `lifecycle.rollbackAll()` —
плагину не нужно ловить событие. Если плагин держит ссылку на `popup`
после rollback'а — вызовы `popup.show()` пойдут в already-closed BC и
будут silent no-op (BC уже отписан registry).

### Id-collisions

`id` для `attachPopup` и `openWindow` живут в **одном** namespace на
relay-стороне (validate non-collision). Не давайте им одинаковые `id` в
одном плагине. Recommended convention: `<pluginId>_<purpose>`
(например `booster-checkout_popup`, `booster-checkout_orders`).

## See also

- [`./capabilities.md`](./capabilities.md) — почему `ctx.sb.ui ===
  undefined` без `Capability.Ui`.
- [`./lifecycle.md`](./lifecycle.md) — порядок rollback'а handle'ов.
- [`./scope-api.md`](./scope-api.md) — `ctx.scope.fetch` для HTTP внутри
  `openWindow`/popup'а.
- `framework/README.md § sb.ui.openWindow` — internals (wrapper HTML,
  centerOnWindow, iframe sandbox).
