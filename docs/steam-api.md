# Steam API

`ctx.sb.steam.*` — навигация и данные текущего пользователя Steam.
Capability — `Capability.Steam`. Источник истины — интерфейсы `SteamApi`
и `SteamUser` в `booster-framework/src/api/api-types.ts` +
`booster-framework/src/api/steam.ts`.

```ts
interface MachineId { bb3: string; ff2: string; b3b: string; }

interface SteamApi {
  openUrl(url: string): Promise<void>;
  getCurrentUser(): SteamUser | null;
  getCurrentUserAsync(): Promise<SteamUser>;
  onUserChange(cb: (user: SteamUser | null) => void): () => void;
  getStoreCountry(): Promise<string | undefined>;
  getMachineId(): Promise<MachineId | undefined>;
}
```

**Где доступно.** `sb.steam` имеет смысл во всех четырёх `ContextKind`:
данные snapshot'а броадкастятся через BroadcastChannel из
SharedJSContext и попадают в каждый таргет. Самый частый kind для
Steam-плагинов — `ContextKind.Main`.

## `getCurrentUser(): SteamUser | null`

**Синхронное** чтение из per-target кэша. Возвращает `null` только в
cold-start окне (~100мс после framework boot) либо после rollback'а
(кэш очищается).

```ts
const u = ctx.sb.steam.getCurrentUser();
if (u) {
  ctx.log.info('login', { name: u.accountName, hasBalance: u.balance != null });
}
```

Когда `null` ожидаем:

1. **Cold start** — framework только что boot'нулся, relay ещё не
   успел push'нуть первый `user-snapshot` (handshake `request-snapshot`
   уже отправлен, но ответ ещё в полёте).
2. **После rollback'а** — `lifecycle.rollbackAll()` сбрасывает кэш до
   следующего injection'а.
3. **Steam offline без сохранённого аккаунта** — login screen открыт,
   snapshot ещё не есть кому отправлять.

Не превращайте `null` в ошибку — это нормальная ветка. Альтернативы:
подождать через `getCurrentUserAsync()` или подписаться на
`onUserChange`.

## `getCurrentUserAsync(): Promise<SteamUser>`

Если кэш уже заполнен — резолвится сразу. Иначе ждёт первый non-null
snapshot.

```ts
async init(ctx) {
  const user = await ctx.sb.steam.getCurrentUserAsync();
  ctx.log.info('user ready', { name: user.accountName });
}
```

**Caveats:**

- **Никогда не резолвится** если Steam так и не залогинился (никогда
  не было snapshot'а). Заверните в `Promise.race` с таймером если важно:

  ```ts
  const user = await Promise.race([
    ctx.sb.steam.getCurrentUserAsync(),
    new Promise<null>(r => ctx.scope.setTimeout(() => r(null), 5_000)),
  ]);
  if (!user) { ctx.log.warn('no user after 5s'); return; }
  ```

- **Reject на rollback.** Если `lifecycle.rollbackAll()` сработает пока
  promise pending — он отклонится с `Error('framework rolled back')`.
  Используйте `ctx.scope.signal` для cleanup.

## `onUserChange(cb)`

Подписка на обновления snapshot'а. Cb срабатывает:

- **Немедленно** если `cachedUser != null` на момент подписки —
  чтобы подписчик инициализировался без ожидания следующего push'а.
- На каждый relay-pushed snapshot diff (логин / смена аккаунта /
  обновление баланса).

```ts
const unsubscribe = ctx.sb.steam.onUserChange((user) => {
  if (!user) return;          // null здесь не приходит — см. ниже
  ctx.log.info('user changed', { name: user.accountName });
});
ctx.signal.addEventListener('abort', unsubscribe, { once: true });
```

`onUserChange` **не вызывает cb с `null`** — после framework rollback'а
listener тихо дропается, финальный `null`-callback не приходит. Если
плагину нужно зарегистрировать logout — используйте `ctx.signal` (abort
срабатывает на rollback) или подписку через `ctx.scope`.

## `getStoreCountry(): Promise<string | undefined>`

Точная **страна магазина** аккаунта (ISO 3166-1 alpha-2, напр. `'KZ'`) — та,
что показана на `store.steampowered.com/account/`. Это НЕ `ipCountry()`
(IP-страна): на VPN/в поездке они расходятся.

```ts
const cc = await ctx.sb.steam.getStoreCountry(); // 'KZ' | undefined
```

- Добывается невидимо, когда пользователь заходит в Steam Store (один
  фоновый запрос `/account/`), и персистится нативно — переживает реинжект
  framework и перезапуск EXE.
- Ключ — `steamId`: при смене аккаунта значение меняется (до повторного
  захвата нового аккаунта вернёт `undefined`).
- `undefined` означает «ещё не добыто» (новый аккаунт, ещё не открывавший
  Store) или «сразу после смены аккаунта». Нативная сторона
  (`get_store_country`) всегда отвечает `{country: string | null}` и не
  ошибается; `undefined` на JS-стороне возникает, если не удалось
  определить `steamId` либо сработал catch/таймаут в `steam.ts`.
  **Никогда не throw.**
- Gated под `Capability.Steam` (как весь `sb.steam`).

## `getMachineId(): Promise<MachineId | undefined>`

Возвращает hardware-derived идентификатор машины из Steam — тройку строк
`{bb3, ff2, b3b}`, извлечённую из `SteamClient.Auth.GetMachineID()` (Valve-binary
MessageObject: `BB3` = disk, `FF2` = mac, `3B3` = other).

```ts
interface MachineId { bb3: string; ff2: string; b3b: string; }
```

```ts
const mid = await ctx.sb.steam.getMachineId();
if (mid) {
  ctx.log.info('machine id available', { hasBb3: mid.bb3.length > 0 });
}
```

- Разбор Valve-binary blob происходит **relay-side** (SharedJSContext) — через
  BroadcastChannel приходят только уже разобранные строки, не ArrayBuffer.
- Кэшируется relay-side навсегда после первого успешного получения (machine id
  не привязан к аккаунту и не меняется между сессиями).
- `undefined` если `SteamClient.Auth.GetMachineID` недоступен, вернул
  неполные данные, или сработал timeout (5 с).
- **Никогда не throw.** **Значения `{bb3, ff2, b3b}` не логируются.**
- Gated под `Capability.Steam` (как весь `sb.steam`).

## `openUrl(url): Promise<void>`

Перенаправляет главное окно Steam'а на URL. Используется для редиректов
платёжных шлюзов.

```ts
await ctx.sb.steam.openUrl('https://store.steampowered.com/app/440');
```

**Validation (sync throw):**

- Length ≤ 2048.
- Protocol `https://` (см. `isUrlSafeForNavigation` в `steam.ts`).
- Без userinfo (`https://user:pass@host/` отвергается).
- Без explicit port'а (`https://host:8080/` отвергается — только 443).

Timeout — 5с (`RELAY_TIMEOUT_MS`). На timeout — reject с
`Error('navigate timeout 5s')`.

**Альтернатива.** Если url нужно открыть в отдельной вкладке Tabbed
Browser'а (платёжный редирект), используйте
[`sb.ui.openExternalWindow`](./ui-api.md#openexternalwindowopts--steam-tabbed-browser).
`openUrl` навигирует **главное** окно — для checkout-сценария он
заменит библиотеку / магазин и пользователь увидит сюрприз.

## `SteamUser`

```ts
interface SteamUser {
  // sync core
  readonly accountName: string;            // login (всегда есть)

  // sync optional (могут отсутствовать в snapshot'е)
  readonly personaName?: string;
  readonly steamId?: string;               // decimal SteamID64
  readonly currency?: string;              // ISO 4217 derived
  readonly balance?: number;               // numeric, parsed
  readonly balanceFormatted?: string;      // как Steam отображает
  readonly isLimited?: boolean;
  readonly isOfflineMode?: boolean;

  // async per-field getters
  email(): Promise<string | undefined>;
  emailValidated(): Promise<boolean | undefined>;
  ipCountry(): Promise<string | undefined>;
  language(): Promise<string | undefined>;
}
```

### Sync fields

Доступны сразу из snapshot'а. **`accountName` гарантирован** при
non-null `SteamUser`. Остальные могут отсутствовать — например
`balance`/`currency` для пустого кошелька, `personaName` в момент
переключения профиля.

- **`currency`** — ISO 4217, выводится из `balanceFormatted` через
  `deriveCurrency` (`steam-internals/currency-map.ts`). Если баланс
  пуст — `undefined`.
- **`balance`** — численное значение из `parseBalanceNumber`. Локаль
  Steam'а имеет значение: `2 177,35₸` → `2177.35`.
- **`balanceFormatted`** — точная строка, которую Steam рисует в UI
  (для отображения «как есть» предпочтительнее, чем композировать из
  `balance + currency`).

### Async getters

Каждый вызов — BC roundtrip к relay'ю в SharedJSContext (который вызывает
`SteamClient.GetAccountSettings` / `User.GetIPCountry` / etc).
Relay-сторона **дедуплицирует** SteamClient-вызовы между плагинами и
между concurrent-вызовами одного плагина (`email()` + `emailValidated()`
с одной микротаски — один roundtrip).

| Getter             | Возвращает                  | TTL  | Cache invalidation |
|--------------------|-----------------------------|------|--------------------|
| `email()`          | `Promise<string \| undefined>` | per-call | смена accountName |
| `emailValidated()` | `Promise<boolean \| undefined>`| per-call | смена accountName |
| `ipCountry()`      | `Promise<string \| undefined>` (ISO 3166-1 alpha-2) | per-call | смена accountName |
| `language()`       | `Promise<string \| undefined>` (например `'russian'`) | per-call | смена accountName |

**Важно:**

- **Promise никогда не reject'ит-ся.** Все ошибки collapsed в
  `undefined`: timeout, отсутствие bridge'а, Steam не вернул значение,
  malformed response. Caller всегда работает с `T | undefined`.
- **Cache hit ≠ sync resolve.** Каждый вызов посылает BC, даже если
  предыдущий ответ дал relay cache hit.
- **Timeout** — 5000 мс. Значение читается в момент вызова из
  `process.env['SB_USER_EXTRA_RELAY_TIMEOUT_MS']` (`getUserExtraTimeoutMs`
  в `steam.ts`); в production-CEF объекта `process` нет, поэтому всегда
  применяется дефолт 5000 мс. Env-override реально работает лишь там, где
  `process` существует (тесты, dev-окружение).

### PII redaction

Async getter'ы возвращают чувствительные данные. По правилам проекта
плагин-автор **обязан не логировать** `accountName`, `steamId`, `email`,
`personaName` напрямую. Используйте плэйсхолдеры:

```ts
const email = await user.email();
ctx.log.info('email check', { hasEmail: email != null });
```

C++ side предоставляет production IPC op `logUserData`, которая пишет одну
диагностическую строку `[booster-user] setupId=… login=…`. Фреймворк вызывает
её при bootstrap (`reportUserBinding`) — только `accountName`, без email /
balance / currency. Подробнее — `CLAUDE.md` § PII redaction.

## Где вызывать

### `init(ctx)` — `ContextKind.Main`

Самый распространённый kind: главное окно Steam'а, есть DOM, есть user-
snapshot. Используйте `getCurrentUserAsync()` или `onUserChange` —
синхронный `getCurrentUser()` чаще всего вернёт `null` в момент init'а.

### `init(ctx)` — `ContextKind.Web`/`TabbedBrowser`

Snapshot тоже броадкастится сюда, но плагин стартует уже **после**
page-load'а, а не вместе с framework boot'ом. Кэш обычно уже warm —
синхронный `getCurrentUser()` нормально работает. Если не уверены —
`getCurrentUserAsync()`.

### Никогда — `ContextKind.Shared`

В SharedJSContext **нет** DOM и нет осмысленной user-сессии (Steam SDK
сам и есть). `sb.steam` технически доступен, но `getCurrentUser()`
вернёт `null` (relay живёт ровно ЗДЕСЬ — это он и пушит snapshot'ы в
другие kinds). Плагины с `ContextKind.Shared` обычно не нужны
сторонним авторам.

## Что делать с `null` user

Снаппшот может прийти позже init'а — это нормально. Универсальный
паттерн через `onUserChange`:

```ts
init(ctx) {
  const refresh = (u: SteamUser | null) => {
    if (!u) return;
    ctx.log.info('persona', { has: u.personaName != null });
  };
  const initial = ctx.sb.steam.getCurrentUser();
  if (initial) refresh(initial);
  const unsubscribe = ctx.sb.steam.onUserChange(refresh);
  return () => unsubscribe();
}
```

Если плагину **обязателен** user (например для composing URL'а с
SteamID'ом) и без него нет смысла продолжать — `await
getCurrentUserAsync()` с таймером (см. выше).

## Примеры

### Простое чтение snapshot'а

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-steam-snap',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Steam snapshot demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Steam],
  async init(ctx: PluginContext): Promise<void> {
    const u = await ctx.sb.steam.getCurrentUserAsync();
    ctx.log.info('balance', {
      formatted: u.balanceFormatted ?? '<empty>',
      currency: u.currency ?? '<unknown>',
    });
  },
});
```

### Подписка на смену пользователя

```ts
import { ContextKind, Capability, type PluginContext, type SteamUser } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-steam-watch',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Steam watch demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Steam],
  init(ctx: PluginContext): () => void {
    let last: string | undefined;
    const unsubscribe = ctx.sb.steam.onUserChange((u: SteamUser | null) => {
      if (!u || u.accountName === last) return;
      last = u.accountName;
      ctx.log.info('user switched', { isLimited: u.isLimited ?? false });
    });
    return unsubscribe;
  },
});
```

### Async getter с graceful fallback

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-steam-async',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Steam async demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Steam],
  async init(ctx: PluginContext): Promise<void> {
    const user = await ctx.sb.steam.getCurrentUserAsync();
    const country  = await user.ipCountry();        // 'ru' | undefined
    const language = await user.language();         // 'russian' | undefined
    ctx.log.info('locale', {
      hasCountry: country  != null,
      hasLanguage: language != null,
    });
  },
});
```

### Навигация на store-страницу

```ts
import { ContextKind, Capability, type PluginContext } from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-steam-nav',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Steam nav demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Steam, Capability.Ui],
  init(ctx: PluginContext): () => void {
    const btn = ctx.sb.ui.addHeaderButton({
      id: 'demo-steam-nav-btn',
      label: 'TF2',
      onClick: async () => {
        try {
          await ctx.sb.steam.openUrl('https://store.steampowered.com/app/440');
        } catch (e) {
          ctx.log.warn('navigate failed', { reason: String(e) });
        }
      },
    });
    return () => btn.remove();
  },
});
```

---

# Keys API

`ctx.sb.keys.*` — активация продуктовых ключей Steam.
Capability — `Capability.Keys`. Источник истины — интерфейс `KeysApi`
в `booster-framework/src/api/api-types.ts` + `booster-framework/src/api/keys.ts`.

```ts
interface KeysApi {
  activate(productKey: string): Promise<ActivateOutcome>;
}
```

## `activate(productKey): Promise<ActivateOutcome>`

Активирует продуктовый ключ Steam для текущего аккаунта.

### Сигнатура

```ts
activate(productKey: string): Promise<ActivateOutcome>
```

### `ActivateOutcome`

```ts
type ActivateOutcome = ActivateSuccess | ActivateFailure;

interface ActivateSuccess {
  ok: true;
  products: { packageId: number; name: string }[];
  transactionId: string;
}

interface ActivateFailure {
  ok: false;
  code: ActivateErrorCode;
  resultDetail: number;
  message: string;  // локализованная строка на русском
}

type ActivateErrorCode =
  | 'already_activated'
  | 'already_owned'
  | 'invalid_key'
  | 'region_locked'
  | 'requires_base_game'
  | 'rate_limited'
  | 'cannot_redeem_from_client'
  | 'account_locked'
  | 'unavailable';
```

`ActivateFailure.message` — локализованная строка (русский), готовая к
показу пользователю. `resultDetail` — числовой код ответа сервера Steam
(для диагностических логов).

### Контракт

**Возвращает `ActivateOutcome`** на любой ответ сервера — успешный или
бизнес-ошибку (ключ уже использован, регион заблокирован и т.д.).

**Бросает исключение** только в двух случаях:

1. **Невалидный аргумент** (синхронный throw на вызове): пустая строка
   или длина > 256 символов.
2. **Транспортная ошибка** (reject с `KeyActivationTransportError`):
   bridge недоступен, timeout, или прочий сбой передачи — **статус ключа
   неизвестен**.

### Не идемпотентно — важно

`activate` **потребляет ключ** при успехе. Повторный вызов с тем же
ключом вернёт `{ ok: false, code: 'already_activated', ... }`.

При **транспортной ошибке** (`KeyActivationTransportError`) статус
ключа **неизвестен**: Steam-сервер мог принять запрос, но ответ не
дошёл. **Не повторяйте вызов автоматически** — покажите пользователю
сообщение вида «статус неизвестен, проверьте библиотеку Steam».

```ts
let res: ActivateOutcome;
try {
  res = await ctx.sb.keys.activate(userEnteredKey);
} catch (e) {
  if (e instanceof KeyActivationTransportError) {
    // Статус неизвестен — НЕ повторять автоматически
    showUnknownStatus();
    return;
  }
  throw e;  // невалидный аргумент — баг вызывающего кода
}

if (res.ok) {
  showSuccess(res.products.map(p => p.name).join(', '));
} else {
  showError(res.message);  // уже локализовано
}
```

### Доступность

`ctx.sb.keys` доступен только если плагин объявил `Capability.Keys` В
`register({ capabilities: [...] })` И manifest-entry выдал его в
`grantedCapabilities`. Иначе `ctx.sb.keys === undefined`.

```ts
if (!ctx.granted.has(Capability.Keys)) {
  ctx.log.warn('keys capability not granted — bailing');
  return;
}
```

### Примеры

#### Базовая активация

```ts
import {
  ContextKind,
  Capability,
  KeyActivationTransportError,
  type PluginContext,
} from '@steambalance/booster-framework';
declare const sb: { plugins: { register: (m: unknown) => void } };

sb.plugins.register({
  id: 'demo-keys-activate',
  version: '0.0.1',
  apiVersion: 1,
  displayName: 'Key activation demo',
  contextKinds: [ContextKind.Main],
  capabilities: [Capability.Keys],
  async init(ctx: PluginContext): Promise<void> {
    if (!ctx.granted.has(Capability.Keys)) return;

    const userEnteredKey = 'XXXXX-XXXXX-XXXXX';

    let res;
    try {
      res = await ctx.sb.keys.activate(userEnteredKey);
    } catch (e) {
      if (e instanceof KeyActivationTransportError) {
        ctx.log.warn('transport failure — status unknown, do NOT retry');
        // показать пользователю: статус неизвестен
        return;
      }
      throw e;
    }

    if (res.ok) {
      ctx.log.info('key activated', { products: res.products.map(p => p.name) });
      // showSuccess(res.products.map(p => p.name).join(', '));
    } else {
      ctx.log.warn('activation failed', { code: res.code, detail: res.resultDetail });
      // showError(res.message);  // уже локализовано
    }
  },
});
```

## See also

- [`./capabilities.md`](./capabilities.md) — полный список capability и правила гейтинга.
- [`./lifecycle.md`](./lifecycle.md) — почему snapshot resets на
  rollback.
- [`./ui-api.md`](./ui-api.md) — `openExternalWindow` против `openUrl`.
