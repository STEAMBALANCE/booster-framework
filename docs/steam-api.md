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
  getOwnedGames(options?: { includePrices?: boolean }): Promise<OwnedGamesResult>;
  getInventory(options?: { apps?: AppContext[]; maxItemsPerApp?: number; includeIcons?: boolean }): Promise<InventoryResult>;
  getAccountLevel(): Promise<number | undefined>;
  getParentalState(): Promise<ParentalState | undefined>;
  getAvatarDataUrl(): Promise<string | null>;
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
  readonly accountId?: number;             // 32-bit account id, derived locally from steamId
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
диагностическую строку `[booster-user] setupId=… login=… region=… currency=…`.
Фреймворк вызывает её при bootstrap (`reportUserBinding`): `accountName`, плюс
регион (store country) и валюта — региональные агрегаты, показывающие, удалось
ли их определить (`(none)` если нет), НЕ идентификация. Без email / steamId /
balance. Подробнее — `CLAUDE.md` § PII redaction.

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

## `GamePrice`

Current store price for one app, from `StoreItemCache`. Currency is the
account wallet currency; all numeric values are in minor units (value ÷ 100 = major units).

```ts
interface GamePrice {
  readonly isFree: boolean;
  readonly unavailable?: boolean;       // delisted / not on store
  readonly regionRestricted?: boolean;  // unavailable in account region
  readonly finalMinor?: number;         // current price, minor units
  readonly originalMinor?: number;      // pre-discount price, minor units
  readonly discountPct?: number;
  readonly formattedFinal?: string;     // e.g. "1 300,00₸"
  readonly formattedOriginal?: string;
}
```

Produced by `sb.steam.getOwnedGames()` price enrichment (Task 6). Sourced
from `StoreItemCache.HintLoadStoreApps` → `IStoreBrowseService/GetItems` —
the same authenticated call the Steam store UI makes, ban-safe.

- `isFree: true` → `finalMinor` is `0`; `originalMinor`, `discountPct`,
  `formattedFinal`, `formattedOriginal` are `undefined`.
- `unavailable: true` → delisted from the store.
- `regionRestricted: true` → unavailable in the account's region.
- Absent map entry → app not found in StoreItemCache (unexpected appid or
  StoreItemCache unavailable).

## `OwnedGame`

Type representing one owned app from `collectionStore`. All time fields are
unix timestamps in seconds (integer).

```ts
interface OwnedGame {
  readonly appid: number;
  readonly name: string;
  readonly appType: number;
  readonly playtimeForeverMinutes: number;
  readonly playtimeTwoWeeksMinutes?: number;
  /** Purchase time. NOTE: free-license re-grants (e.g. CS2/HL2) can reset this. */
  readonly purchasedAt?: number;
  readonly releaseAt?: number;
  readonly lastPlayedAt?: number;
  readonly metacritic?: number;
  readonly sizeOnDiskBytes?: number;
  /** Present only when getOwnedGames({includePrices:true}). */
  readonly price?: GamePrice;
}
```

Produced by `sb.steam.getOwnedGames()`. Sourced from the in-memory
`collectionStore` — no network request.

## `OwnedGamesResult`

```ts
interface OwnedGamesResult {
  readonly games: OwnedGame[];
  readonly pricesIncluded: boolean;
  /** Account wallet currency (ISO-4217 when derivable). Account-wide. */
  readonly currency?: string;
  /** false if collectionStore wasn't populated in time. */
  readonly ready: boolean;
  /** Games dropped because they are borrowed via Family Sharing. */
  readonly familySharedExcluded?: number;
}
```

Returned by `sb.steam.getOwnedGames()`. `currency` is derived from the
first `GamePrice.formattedFinal` encountered in the library (same mechanism
as `SteamUser.currency`). `ready: false` means the library wasn't populated
within the wait window — games array will be empty.

## `getOwnedGames(options?): Promise<OwnedGamesResult>`

Returns the full owned-game library from `collectionStore` with rich metadata.
Optionally enriches each entry with the current store price (account wallet
currency) via `StoreItemCache` — the same authenticated `GetItems` call the
Steam store UI makes, so it is ban-safe and requires no extra network credentials.

```ts
const r = await ctx.sb.steam.getOwnedGames();
// r.ready === false → library not yet populated (rare cold-start race)
for (const g of r.games) {
  ctx.log.info('game', { appid: g.appid, playtime: g.playtimeForeverMinutes });
}

// With prices:
const rp = await ctx.sb.steam.getOwnedGames({ includePrices: true });
ctx.log.info('library', { count: rp.games.length, currency: rp.currency });
```

- **Never rejects.** Returns `{ games: [], pricesIncluded, ready: false }` on
  relay timeout (5 s default).
- **Ban-safe.** `includePrices` rides `StoreItemCache.HintLoadStoreApps` —
  the client's own batched `IStoreBrowseService/GetItems`. No extra HTTP
  calls attributable to the plugin.
- **`ready: false`** means `collectionStore.allGamesCollection.allApps` was
  empty after a 3-second bounded wait. Very rare — only on extreme cold start.
- **`currency`** is derived relay-side from the first available
  `GamePrice.formattedFinal`; `undefined` if no prices loaded or no currency
  symbol was recognised.
- Gated under `Capability.Steam`.

## `AppContext`

One `(appid, contextid)` inventory partition. `contextid` is a **string** —
Steam context ids can exceed `Number.MAX_SAFE_INTEGER`.

```ts
interface AppContext {
  readonly appid: number;
  readonly contextid: string;
}
```

Defaults probed by `getInventory()` when `options.apps` is omitted: CS2
(`730/2`), Dota 2 (`570/2`), TF2 (`440/2`), Rust (`252490/2`), Steam Community
items / trading cards (`753/6`).

## `InventoryItem`

One inventory asset merged with its class/instance description. **Slim by
default** — `iconUrl` is populated only with `{ includeIcons: true }`. Item
**prices are out of scope** (computed by the backend, not here).

```ts
interface InventoryItem {
  readonly appid: number;
  readonly contextid: string;
  readonly assetid: string;
  readonly classid: string;
  readonly instanceid: string;
  readonly amount: number;
  readonly marketHashName?: string;
  readonly marketName?: string;
  readonly name?: string;
  readonly type?: string;
  readonly marketable: boolean;
  readonly tradable: boolean;
  readonly marketFeeApp?: number;
  readonly iconUrl?: string;        // path/hash fragment, only when includeIcons — NOT a full URL; prepend CDN base to use
}
```

All id fields are strings (asset/class/instance ids overflow `number`).
`marketHashName` is the canonical key for backend price lookups.

## `InventoryAppResult`

Per-`(app, context)` fetch outcome — surfaces partial failures without losing
the items other apps returned.

```ts
interface InventoryAppResult {
  readonly appid: number;
  readonly contextid: string;
  readonly totalCount?: number;     // total_inventory_count reported by Steam
  readonly fetched: number;
  readonly ok: boolean;
  readonly error?: string;
}
```

`fetched < totalCount` means the app was truncated at `maxItemsPerApp`
(`ok` still `true`, but `InventoryResult.partial` is set). `ok: false` with an
`error` string means that app's fetch failed (e.g. `eresult <n>` or an
exception) — other apps are unaffected.

## `InventoryResult`

```ts
interface InventoryResult {
  readonly items: InventoryItem[];
  readonly perApp: InventoryAppResult[];
  readonly partial: boolean;        // any app failed OR any app truncated
}
```

`items` is the flattened union across every requested app. `partial` is `true`
if **any** app failed or was truncated at `maxItemsPerApp`. When the inventory
machinery can't be resolved at all, `items` is empty, every `perApp` entry is
`ok: false`, and `partial` is `true`.

## `getInventory(options?): Promise<InventoryResult>`

Reads the **logged-in user's own** inventory over the Steam client's
authenticated CM transport (`Econ.GetInventoryItemsWithDescriptions`). Because
it rides the client's own session, it is **complete even when the public
inventory is private** — unlike the public web inventory endpoint. Item
**prices are out of scope** (the backend computes those from `marketHashName`).

```ts
const r = await ctx.sb.steam.getInventory();           // default app set, slim items
for (const it of r.items) {
  ctx.log.info('item', { app: it.appid, hash: it.marketHashName ?? '<none>', tradable: it.tradable });
}
if (r.partial) ctx.log.warn('inventory partial', { perApp: r.perApp.map((a) => ({ app: a.appid, ok: a.ok })) });

// Narrow to specific apps, raise the per-app cap, include icon hashes:
const cs = await ctx.sb.steam.getInventory({ apps: [{ appid: 730, contextid: '2' }], maxItemsPerApp: 5000, includeIcons: true });
```

- **Never rejects.** Returns `{ items: [], perApp: [...ok:false...], partial: true }`
  if the inventory machinery is unavailable, or the safe default on relay timeout.
- **Ban-safe.** Rides the client's own authenticated CM (the same transport the
  Steam UI uses) — no extra HTTP attributable to the plugin, no web-API key.
- **`options.apps`** — defaults to the set above (`AppContext`). Each entry is
  fetched independently; a failure in one does not abort the others.
- **`options.maxItemsPerApp`** — default `2000`. Pagination
  (`more_items`/`last_assetid`, page size 2000) merges across pages until this
  cap; hitting it sets `partial: true` and that app's `fetched` equals the cap.
- **`options.includeIcons`** — default `false`; items are slim (no `iconUrl`)
  unless set, to keep the relay payload small.
- Gated under `Capability.Steam`.

## `getAccountLevel(): Promise<number | undefined>`

Returns the current user's Steam account level (the XP/badge level shown on
the Steam profile). Fetched relay-side in two stages: CM first
(`Player.GetGameBadgeLevels` over `SharedConnection`), miniprofile fallback
second (`steam-chat.com/miniprofile/<accountId>/json/`).

```ts
const level = await ctx.sb.steam.getAccountLevel(); // 42 | undefined
```

- **Never rejects.** Returns `undefined` if both paths are unavailable (no
  `g_FriendsUIApp`, no `steamAjaxRequest`, relay timeout).
- `accountId` is derived from the current user snapshot (`SteamUser.accountId`)
  and forwarded to the relay so the miniprofile fallback targets the right
  account.
- Gated under `Capability.Steam`.

---

## `getAvatarDataUrl(): Promise<string | null>`

Returns the current user's avatar as a small JPEG **data URI** (downscaled to
~128px), ready to drop straight into an `<img src>`.

```ts
const avatar = await ctx.sb.steam.getAvatarDataUrl(); // "data:image/jpeg;base64,…" | null
if (avatar) img.src = avatar;
```

- Read relay-side (SharedJSContext) from the local avatar cache
  (`steamloopback.host/avatarcache/<steamId64>.png`) and re-encoded to a small
  JPEG via a same-origin canvas (so the canvas isn't tainted). Typical output is
  ~5–10 KB vs the raw PNG's tens of KB.
- **Why a data URI and not a URL:** the public avatar CDN URL isn't derivable
  client-side (the client exposes no reliable avatar hash for the local user),
  and the loopback `avatarcache` path isn't reachable from a content browser —
  so the bytes are packed inline.
- Animated (APNG) avatars collapse to their first frame.
- **Never rejects.** Returns `null` if the current `steamId` can't be resolved,
  the cache file is missing, or encoding fails.
- Gated under `Capability.Steam`.

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

---

## `getParentalState(): Promise<ParentalState | undefined>`

Состояние семейного просмотра Steam (Family View / родительский контроль).

```ts
interface ParentalState {
  /** Семейный просмотр когда-либо настраивался на этом аккаунте. */
  readonly everEnabled: boolean;
  /** Семейный просмотр АКТИВЕН сейчас — библиотека и инвентарь закрыты PIN-кодом. */
  readonly locked: boolean;
}
```

```ts
const st = await ctx.sb.steam.getParentalState();
if (st?.locked) {
  // Данные Steam недостоверны: сторы под PIN-локом читаются пустыми.
}
```

Источник — `SteamClient.Parental.RegisterForParentalSettingsChanges`. Steam
отдаёт состояние только через подписку, поэтому фреймворк делает
одноразовое чтение с таймаутом и сразу отписывается.

`undefined` означает **неизвестно** (не SharedJSContext, API отсутствует,
колбэк не сработал вовремя) — это **не** «разблокировано». Никогда не throw.

**Почему это важно.** При `locked: true` `collectionStore` и инвентарь
читаются пустыми, из-за чего оценка аккаунта раньше давала уверенный ноль.
`collectRatePayload` теперь заранее проверяет флаг и отклоняется с кодом
`sb_family_view_locked`, а не собирает заведомо неверные данные.
