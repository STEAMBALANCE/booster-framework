# Embed-мост: SteamBooster ↔ cross-origin страница в iframe

Двусторонний `window.postMessage`-мост между обёрткой `openWindow`
(loopback-origin, прямой родитель iframe) и cross-origin страницей
(например `steambalance.cc`) внутри этого iframe.

**Зачем:** embed-режим / косметика (скрыть лишние элементы, адаптировать
вёрстку под Steam-окно), аналитика, двусторонний обмен данными между
плагином и страницей. Мост **не** реализует модель доверия — аутентификация
и авторизация запросов лежат на уровне back-end'а страницы.

Мост активен только в url-режиме `openWindow` (`url:` опция). html-режим
не затронут.

## Поведение при навигации

- **Full navigation (клик по ссылке)** — `iframe.load` срабатывает на
  каждой загрузке, обёртка повторно отправляет `sb:embed` в новый
  `frame.contentWindow`.
- **SPA / hash-only переход** — `iframe.load` не срабатывает; состояние
  сохраняется. Страница может запросить init в любой момент через `sb:ready`
  (pull-механизм).
- **Cross-origin переход вне `embedOrigins`** — проактивный push с
  `targetOrigin=FRAME_ORIGIN` браузер не доставит (origin mismatch); факт
  бустера не утекает сторонним сайтам. Pull-ответ идёт только если
  `event.origin ∈ EMBED_ORIGINS`.

Главный механизм надёжности — **pull**: страница при загрузке отправляет
`sb:ready`; обёртка отвечает `sb:embed`. Round-trip на loopback << 300 мс,
поэтому pull достоверен и быстр.

## Протокол сообщений

Все сообщения моста несут namespace-маркер:

```
{ __sbEmbed: true, v: 1, type, … }
```

### Родитель → страница: `sb:embed`

Отправляется обёрткой на `iframe.load` и в ответ на `sb:ready`.

```jsonc
{
  "__sbEmbed": true,
  "v": 1,
  "type": "sb:embed",
  "windowId": "<uuid>",
  "app": { "name": "SteamBooster", "version": "1.2.3" }
}
```

Форма фиксирована: фреймворк всегда шлёт ровно эти поля, без `plugin`
и без `payload`. Данные, специфичные для конкретного плагина, приходят
**отдельным сообщением** через `handle.postMessage(data)` — страница
получает `data` как есть, оно не оборачивается в `sb:embed`. Форму этого
сообщения определяет плагин. Например, booster-checkout отправляет:

```jsonc
{ "__sbEmbed": true, "v": 1, "type": "sb:embed-payload", "source": "booster-checkout" }
```

Страница должна слушать `sb:embed` (авторитетное «открыто в SteamBooster»
+ версия приложения) и отдельно — любой `type`, который ей интересен
(например `sb:embed-payload`).

### Страница → родитель

**`sb:ready`** — listener поднят, запрашивает init:

```jsonc
{ "__sbEmbed": true, "v": 1, "type": "sb:ready" }
```

**`sb:event`** — команды и данные назад в плагин:

```jsonc
{ "__sbEmbed": true, "v": 1, "type": "sb:event", "name": "order-viewed", "data": { … } }
```

Плагин получает эти сообщения через `handle.on('message', cb)`.
Обёртка пробрасывает **любое** принятое сообщение (прошедшее фильтр `source`+`origin` и проверку размера), не являющееся `sb:ready`, — не только сообщения в форме `sb:event`. Авторы плагинов обязаны валидировать форму входящего сообщения самостоятельно (booster-checkout делает это).

### Плагин → страница

После получения `sb:ready` плагин может отправить произвольный JSON:

```ts
handle.postMessage({ __sbEmbed: true, v: 1, type: 'sb:embed-payload', … });
```

**Контракт:** плагин обязан слать enrichment **только после получения
`sb:ready`** от страницы. До этого момента у страницы нет активного
listener'а; сообщение будет молча потеряно.

Лимит payload: **16 КБ** (`WINDOW_MESSAGE_MAX_BYTES`) в обе стороны. Превышение — drop без ошибки.

## Origin-правила

- **Origin родителя** (обёртки) — `https://steamloopback.host`.
- **Страница не хардкодит** origin родителя. Она пинит первый источник
  валидного `sb:embed` (`event.source` + `event.origin`, нормализованный
  браузером) и отвечает только ему через
  `event.source.postMessage(reply, event.origin)`.
- **Обёртка** всегда использует явный `targetOrigin` (`FRAME_ORIGIN` или
  валидированный `event.origin`), **никогда `'*'`**. Входящие сообщения
  фильтруются строго по `source` + `origin`.
- `embedOrigins` задаёт допустимые origin'ы для переходов внутри iframe
  (помимо origin стартового `url`). Default — только origin стартового `url`.

## Сниппет детекции для страницы

Вставить в `<head>` страницы, до любого прикладного JS:

```js
(function detectSteamBooster() {
  if (window.parent === window) { window.__sbEmbedded = false; return; }
  let resolved = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__sbEmbed !== true || d.type !== 'sb:embed') return;
    resolved = true;
    window.__sbEmbedded = true;
    window.__sbEmbedInfo = d;
    window.__sbParent = { source: e.source, origin: e.origin };
    document.documentElement.setAttribute('data-sb-embedded', '1');
    window.dispatchEvent(new CustomEvent('sb:embed', { detail: d }));
  });
  try { window.parent.postMessage({ __sbEmbed: true, v: 1, type: 'sb:ready' }, '*'); } catch {}
  // 300 мс — только негативный кэш «открыто автономно»; loopback round-trip << 300 мс. Тюнится.
  setTimeout(() => { if (!resolved) window.__sbEmbedded = false; }, 300);
})();
```

После выполнения сниппета:

- `window.__sbEmbedded` — `true` если открыто в SteamBooster, `false` если
  открыто автономно (после 300 мс таймаута), `undefined` в течение таймаута.
- `window.__sbEmbedInfo` — последний полученный `sb:embed` объект.
- `window.__sbParent` — `{ source, origin }` для ответных сообщений.
- Атрибут `data-sb-embedded="1"` на `<html>` — удобен для CSS-адаптации.
- Событие `sb:embed` диспатчится на `window` при каждом рукопожатии (в т.ч.
  при повторном `iframe.load`).

Для отправки ответа плагину после рукопожатия:

```js
window.addEventListener('sb:embed', () => {
  if (!window.__sbParent) return;
  window.__sbParent.source.postMessage(
    { __sbEmbed: true, v: 1, type: 'sb:event', name: 'page-ready', data: {} },
    window.__sbParent.origin,
  );
});
```

## Опция `embedOrigins`

```ts
await ctx.sb.ui.openWindow({
  id: 'my-window',
  title: 'Заказы',
  url: 'https://steambalance.cc/booster/orders',
  width: 900,
  height: 600,
  embedOrigins: ['https://pay.steambalance.cc'],
});
```

| Поле            | Тип        | Default | Описание |
|-----------------|------------|---------|----------|
| `embedOrigins?` | `string[]` | origin стартового url (auto) | Дополнительные https-origin'ы (помимо origin стартового `url`), которым обёртка отвечает на `sb:ready` при навигации. Эффективный список всегда включает origin `url` (добавляется автоматически); переданный массив объединяется с ним. Каждый элемент — точный `https://host` без path/порта/userinfo. Relay валидирует и ограничивает до 8 записей. Только url-режим. |

По умолчанию (без `embedOrigins`) обёртка отвечает только origin стартового
`url`. Добавьте в список origin'ы, на которые может переходить iframe и
которым тоже нужен embed-контекст (например платёжный поддомен).

## Граница гарантии

Рукопожатие достоверно, если страница открыта **внутри реального
SteamBooster**: обёртка живёт на `steamloopback.host`, и браузер CEF
гарантирует, что `window.parent` в cross-origin iframe — это реальный
loopback-родитель. Подделка флага сторонним встраивателем (другой iframe на
другом сайте) — вне модели угроз данной реализации. При необходимости
верификации на стороне сервера — апгрейд до подписанного токена (отдельный
шаг).

## См. также

- [`./ui-api.md`](./ui-api.md#openwindowopts--steam-native-окно-с-iframe) — `openWindow` API, опции, handle.
- [`./plugin-contract.md`](./plugin-contract.md) — capabilities, lifecycle.
