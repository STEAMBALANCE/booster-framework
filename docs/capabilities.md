# Capabilities

`Capability` — это явный grant, который ограничивает, к каким sub-API
`window.sb` имеет доступ плагин. Принципы:

- **Default-deny + явный allow**: ни один gated sub-API не доступен,
  пока его capability не выдан в подписанном манифесте И не запрошен
  бандлом.
- **Effective = intersection**: реальный набор = `bundle.capabilities ∩
  manifestEntry.grantedCapabilities`. Эта инвариант реализован в
  `booster-framework/src/plugins/capability-gating.ts::buildGatedSb`.
- **Не выдан → `undefined`**: на gated-поле `ctx.sb.<cap>` не бросается
  исключение — оно просто `undefined`. Это позволяет писать guarded-код
  без try/catch.

## Полный список capability'ев

Источник истины — `const Capability` в `booster-framework/src/api/api-types.ts`:

```ts
export const Capability = {
  Ui:       'ui',
  Steam:    'steam',
  Configs:  'configs',
  Bus:      'bus',
  Pages:    'pages',
  Keys:     'keys',
} as const;
```

| Capability   | Gated API           | Чем пользуется плагин                                            |
|--------------|---------------------|------------------------------------------------------------------|
| `Ui`         | `ctx.sb.ui`         | `addHeaderButton`, `attachPopup`, `openWindow`, `openExternalWindow`, `addMenuItem`, `addStoreNavButton`, `addSuperNavButton`. |
| `Steam`      | `ctx.sb.steam`      | `openUrl`, `getCurrentUser`, `getCurrentUserAsync`, `onUserChange`, `getStoreCountry`. |
| `Configs`    | `ctx.sb.configs` И `ctx.configs` | Encrypted JSON-storage `read`/`write` по имени, per-plugin namespace. |
| `Bus`        | `ctx.sb.bus`        | Cross-target pub/sub `publish`/`subscribe`.                      |
| `Pages`      | `ctx.sb.pages`      | URL-matched page router (`register({name, match, mount})`).      |
| `Keys`       | `ctx.sb.keys`       | `activate(productKey)` — активирует продуктовый ключ Steam. Потребляет ключ при успехе; **не идемпотентно**. |

## Always-available (не требуют capability)

Эти поля живут на `ctx.sb` ВСЕГДА:

- `ctx.sb.version` — версия фреймворка (string).
- `ctx.sb.state` — `'loading' | 'ready' | 'disabled'` по типу; в текущем
  бандле значение зафиксировано как `'loading'` и не переключается, так что
  на переходы состояний полагаться нельзя.
- `ctx.sb.context` — `{ kind, url, onUrlChange }`.
- `ctx.sb.lifecycle` — `ready()`, `rollbackAll()`.
- `ctx.sb.scope` — alias для `ctx.scope` через framework's scope.
- `ctx.sb.plugins` — `register`, `ready` (плагин-registry meta API).

Плюс per-plugin не-gated поля прямо в `ctx`:

- `ctx.scope` — own AbortController + auto-cleanup helpers.
- `ctx.log` — structured logger (через bridge → C++ spdlog).
- `ctx.signal` — alias на `ctx.scope.signal`.

## Capability availability

Любой сторонний плагин может запросить и получить любой из этих
capability'ев, если manifest-владелец (оператор STEAMBALANCE) включит их
в подписанный manifest-entry. Проверка прав — не «может ли», а «включил
ли оператор в manifest»:

- `Ui`
- `Steam`
- `Configs`
- `Bus`
- `Pages`
- `Keys`

## Как плагин запрашивает capabilities

В `PluginManifest.capabilities` бандл-стороны (см.
[`./plugin-contract.md`](./plugin-contract.md)):

```ts
sb.plugins.register({
  id: 'my-plugin',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Мой плагин',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui, Capability.Configs],
  init(ctx) { /* ... */ },
});
```

Запрос — это намерение бандла. Реальный grant решается на стороне
оператора через manifest-подпись. Если в manifest-entry оператора
`grantedCapabilities: ['ui']`, а бандл просит `[Ui, Configs]` — effective
будет `{Ui}`, и `ctx.sb.configs === undefined`.

## Effective grant formula

Источник — `bootstrap.ts::drainPluginsOnReady`:

```ts
const granted = new Set<Capability>(
  bundle.capabilities.filter((c) =>
    manifestEntry.grantedCapabilities.includes(c as string),
  ),
);
```

То есть:

```
effective = bundle.requested  ∩  manifest.granted
```

Если бандл запрашивает `[Ui]`, а manifest даёт `[Ui, Configs]` —
effective `{Ui}` (manifest расширить не может). Если бандл запрашивает
`[Ui, Configs]`, а manifest даёт `[Ui]` — effective `{Ui}`, и
`ctx.sb.configs === undefined`.

`ctx.granted` — это `ReadonlySet<Capability>` ровно с effective set'ом.
Это **единственный** надёжный способ узнать, доступен ли API:

```ts
if (ctx.granted.has(Capability.Steam)) {
  const user = await ctx.sb.steam.getCurrentUserAsync();
  // ...
}
```

## Что происходит при доступе к ungranted capability

Из `capability-gating.ts`:

```ts
ui: granted.has(Capability.Ui) ? real.ui : (undefined as never),
```

Runtime'ом поле — `undefined`. TS-типизация — `UiApi` (через `as never`
trick'и), и компилятор НЕ предупредит на `ctx.sb.ui.addHeaderButton(...)`.
Runtime это даст `TypeError: Cannot read properties of undefined`.

Корректный паттерн — guarded access:

```ts
if (ctx.granted.has(Capability.Ui)) {
  ctx.sb.ui.addHeaderButton({ /* ... */ });
}
```

Или, если плагин обязательно требует capability — fail-fast:

```ts
init(ctx) {
  if (!ctx.granted.has(Capability.Steam)) {
    ctx.log.warn('steam capability missing — bailing');
    return;
  }
  // ... остальной init безопасен
}
```

## Примеры

### `Ui` — кнопка в шапке

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-ui',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'UI demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Ui],
  init(ctx: PluginContext): () => void {
    const btn = ctx.sb.ui.addHeaderButton({
      id: 'demo-btn',
      label: 'Привет',
      onClick: () => ctx.log.info('clicked'),
    });
    return () => btn.remove();
  },
});
```

> **Расширенная поверхность `Ui`.** `addMenuItem` инжектит DOM в
> **привилегированный SharedJSContext** (там доступны `SteamClient`,
> `g_PopupManager`, `MainWindowBrowserManager`) и по клику навигирует главное
> окно Steam. Поэтому `icon`-SVG **санитайзится** relay'ем (allowlist тегов/
> атрибутов, вырезание `on*`/script/внешних ссылок), а `url` проходит
> `isUrlSafeForNavigation` (https-only, без userinfo/порта) на обеих сторонах.
> Помните об этом, выдавая `Ui` сторонним (`approvedPlugins[]`) плагинам. См.
> [`./ui-api.md`](./ui-api.md#addmenuitemopts--пункт-в-верхней-навигации-steam).

### `Steam` — guarded async доступ

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-steam',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Steam demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Steam],
  async init(ctx: PluginContext): Promise<void> {
    if (!ctx.granted.has(Capability.Steam)) return;
    const user = await ctx.sb.steam.getCurrentUserAsync();
    ctx.log.info('user has balance?', { has: user.balance != null });
  },
});
```

### `Configs` — per-plugin namespace

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

interface Saved { readonly counter: number; }

sb.plugins.register({
  id: 'demo-configs',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Configs demo',
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

### `Bus` — кросс-таргет broadcast

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-bus',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Bus demo',
  contextKinds: [ContextKind.Main, ContextKind.Web],
  capabilities: [Capability.Bus],
  init(ctx: PluginContext): void {
    // topic должен начинаться с pluginId — иначе sync throw.
    ctx.sb.bus.publish('demo-bus.ping', { at: Date.now() });
    ctx.sb.bus.subscribe('demo-bus.pong', (data) => {
      ctx.log.info('got pong', { data });
    });
  },
});
```

### `Pages` — URL-matched mount

```ts
import { ContextKind, Capability, type PluginContext, type PageContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-pages',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Pages demo',
  contextKinds: [ContextKind.Web],
  capabilities: [Capability.Pages],
  init(ctx: PluginContext): void {
    ctx.sb.pages.register({
      name: 'store',
      match: { url: /https:\/\/store\.steampowered\.com\/app\// },
      mount(pageCtx: PageContext): () => void {
        ctx.log.info('on store app page', { url: pageCtx.url.href });
        return () => ctx.log.info('left store app page');
      },
    });
  },
});
```

### `Keys` — активация продуктового ключа

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-keys',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Keys demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Keys],
  async init(ctx: PluginContext): Promise<void> {
    if (!ctx.granted.has(Capability.Keys)) return;
    const res = await ctx.sb.keys.activate('XXXXX-XXXXX-XXXXX');
    if (res.ok) {
      ctx.log.info('activated', { products: res.products.map(p => p.name) });
    } else {
      ctx.log.warn('activation failed', { code: res.code });
    }
  },
});
```

## Diagnostics

Capability-skipping тих по дизайну (нет warn-лога) — это намеренно: после
N плагинов с разными granted-set'ами warn-спам перевесит сигнал. Способ
диагностики:

- `ctx.log.info('granted', { caps: [...ctx.granted] })` в собственном
  init — увидите эффективный set.
- Если ожидаемый API `undefined` — открыть подписанный manifest-entry,
  посмотреть `grantedCapabilities`.

См. [`./troubleshooting.md`](./troubleshooting.md) для полного
flowchart'а.

## See also

- [`./plugin-contract.md`](./plugin-contract.md) — куда capabilities идут
  в `PluginManifest`.
- [`./steam-api.md`](./steam-api.md) — `Keys` API: `sb.keys.activate`,
  `ActivateOutcome`, error codes.
- [`./lifecycle.md`](./lifecycle.md) — когда capability вычисляется
  (на момент `drainPluginsOnReady`).
