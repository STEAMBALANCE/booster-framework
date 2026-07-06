# Net API

`ctx.sb.net.*` — нативно-проксируемый fetch к хостам из подписанного
`allowedHosts` плагина, в обход CSP/CORS Steam-страниц.
Capability — `Capability.Net`. Источник истины — интерфейсы `NetApi`,
`NetFetchInit`, `NetResponse` в `booster-framework/src/api/api-types.ts`
+ `booster-framework/src/api/net.ts`.

```ts
interface NetApi {
  fetch(url: string, init?: NetFetchInit): Promise<NetResponse>;
}

interface NetFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface NetResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}
```

`makeNetApi(bridge)` — тонкая обёртка над одним bridge round-trip'ом:
`ctx.sb.net.fetch(url, init)` вызывает нативный op `net_fetch` с
аргументами `{ url, method, headers, body, timeoutMs }` (поля с
`undefined`-значением из `init` в envelope не попадают — `method`
дефолтится к `'GET'`) и мапит нативный результат
`{ status, ok, headers, body }` в `NetResponse` (`text()`/`json<T>()`
читают предзагруженный `body`, ничего заново по сети не запрашивают).

## `allowedHosts` enforcement

`url` обязан быть `https` И его host обязан входить в `allowedHosts`
подписанной manifest-записи вызывающего плагина. Проверка — по токену
envelope'а (native router резолвит plugin identity по токену, а не по
самодекларируемому `pluginId`), то есть подделать `pluginId` в `args`
бесполезно. Хост не в списке → `fetch(...)` реджектится. См.
[`./plugin-contract.md`](./plugin-contract.md#net-allowedhosts-acl-allowedhosts)
про формат и threading поля `allowedHosts`.

## Без редиректов

`net_fetch` НЕ следует за редиректами — 3xx-ответ возвращается вызывающему
как есть (`status` в диапазоне 3xx, `ok: false`). Если апстрим-API редиректит,
обрабатывайте `Location`-заголовок на стороне плагина явно (при необходимости
делая повторный `fetch` на новый URL — при условии, что новый хост тоже в
`allowedHosts`).

## Нативные identity-заголовки

Заголовки идентификации (`x-booster*`, `User-Agent`, `Host`) выставляет
нативный инжектор безусловно — они НЕ настраиваются и НЕ перезаписываются
через `init.headers`. `init.headers` предназначен только для safe
caller-заголовков (`Accept`, `Content-Type` и т.п.); зарезервированные/
identity-ключи молча дропаются нативной стороной, даже если вызывающий код
их передал.

## Лимиты и timeout

- **Envelope cap.** `body` (и весь args-envelope bridge-вызова) подчиняется
  общему ~60 КБ лимиту bridge-конверта — как и любой другой `bridge.call`.
- **timeoutMs.** Клэмпится нативно до ≤ 9000 мс (сам bridge-конверт кэпает
  round-trip на 10 с). Передавать больше — не ошибка, но эффективный timeout
  не превысит 9000 мс.
- **Response size cap.** Нативная сторона отклоняет ответ, превышающий
  собственный size-cap (см. injector-side `net_fetch` реализацию) —
  `fetch(...)` реджектится, а не возвращает усечённое тело.

## `GET`/`POST` only (v1)

`init.method` принимает только `'GET' | 'POST'` — иных HTTP-методов v1 не
поддерживает. По умолчанию `'GET'`, если `init` не передан или `method`
не указан.

## `init.signal` — зарезервировано

`init.signal` — задел на будущее; в v1 framework НЕ прокидывает abort
в нативный op (у `net_fetch` собственный timeout). Передавать
`AbortSignal` сегодня — no-op, поле не влияет на поведение вызова.

## Error mapping

`fetch(url, init)` реджектится (не возвращает `NetResponse` с
`ok: false`) в случаях, которые нельзя выразить HTTP-статусом:

- хост не входит в `allowedHosts` вызывающего плагина;
- `Capability.Net` не выдан (плагин не должен был долетать до вызова —
  см. [`./capabilities.md`](./capabilities.md#net));
- размер ответа превышает нативный size-cap;
- транспортная/TLS-ошибка (нет соединения, timeout, revocation-check
  fail и т.п.).

HTTP-статусы (включая 4xx/5xx/3xx) — это **успешный** resolve с
`ok: status ∈ [200,299]`; они НЕ приводят к reject.

`NetResponse.json<T>()` дополнительно реджектится, если тело ответа —
не валидный JSON (`JSON.parse` throw), независимо от того, что вернул
нативный op.

```ts
const r = await ctx.sb.net.fetch('https://steambalance.cc/api/x');
if (!r.ok) {
  ctx.log.warn('net_fetch non-2xx', { status: r.status });
  return;
}
try {
  const data = await r.json<{ items: unknown[] }>();
} catch {
  ctx.log.warn('net_fetch: invalid JSON body');
}
```

## Доступность

`ctx.sb.net` доступен только если плагин объявил `Capability.Net` в
`register({ capabilities: [...] })` И manifest-entry выдал его в
`grantedCapabilities` И в той же manifest-записи присутствует
`allowedHosts` с нужным хостом. Иначе `ctx.sb.net === undefined`
(capability не выдан) или `fetch(...)` реджектится (host не в
`allowedHosts`, даже если capability выдан).

```ts
if (!ctx.granted.has(Capability.Net)) {
  ctx.log.warn('net capability not granted — bailing');
  return;
}
```

## Пример

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-net-fetch',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Net fetch demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Net],
  async init(ctx: PluginContext): Promise<void> {
    if (!ctx.granted.has(Capability.Net)) return;

    const r = await ctx.sb.net.fetch('https://steambalance.cc/api/booster/catalogue', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 5000,
    });
    if (!r.ok) {
      ctx.log.warn('catalogue fetch failed', { status: r.status });
      return;
    }
    const { data } = await r.json<{ data: unknown[] }>();
    ctx.log.info('catalogue loaded', { count: data.length });
  },
});
```

## See also

- [`./capabilities.md`](./capabilities.md#net) — где `Net` в общем списке
  capability'ев и формула effective grant.
- [`./plugin-contract.md`](./plugin-contract.md#net-allowedhosts-acl-allowedhosts) —
  формат `allowedHosts` в manifest-записи и threading через pipeline.
