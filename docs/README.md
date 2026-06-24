# booster-framework — руководство для авторов плагинов

Русскоязычная документация публичного API `@steambalance/booster-framework` —
поверхности `window.sb`, которой пользуются плагины steambooster.

## С чего начать

- [Getting Started](./getting-started.md) — от `gh repo create` до
  работающей кнопки в шапке Steam за ≈30 минут.

## Reference

- [Plugin Contract](./plugin-contract.md) — `sb.plugins.register`,
  `PluginManifest`, `PluginContext`, lifecycle-цепочка.
- [Capabilities](./capabilities.md) — список capability'ов, формула
  effective grant.
- [Lifecycle](./lifecycle.md) — init / cleanup тайминги, rollback,
  hot-reload (dev only).
- [UI API](./ui-api.md) — `sb.ui.addHeaderButton`, `attachPopup`,
  `openWindow`, `openExternalWindow`.
- [Steam API](./steam-api.md) — `sb.steam.openUrl`, `getCurrentUser`,
  `getCurrentUserAsync`, `onUserChange`, `getStoreCountry`.
- [Configs API](./configs-api.md) — `sb.configs.read` /
  `write`, per-plugin namespace, шифрование libsodium
  (XChaCha20-Poly1305), квота.
- [Bus API](./bus-api.md) — `sb.bus.publish` / `subscribe`,
  cross-target broadcast, prefix-правила.
- [Pages API](./pages-api.md) — `sb.pages.register`, URL-matched
  mount/unmount.
- [Scope API](./scope-api.md) — `sb.scope.*` хелперы,
  AbortController-паттерны, авто-очистка на rollback.
- [Testing](./testing.md) — `@steambalance/booster-framework/testing`,
  `createTestPluginContext`, `TestInspector`.

## Operator / Troubleshooting

- [Troubleshooting](./troubleshooting.md) — apiVersion mismatch,
  capability denial, hot-reload race, port conflict.

## См. также

- Шаблон плагина: https://github.com/STEAMBALANCE/booster-plugin-template
- Публичные плагины: https://github.com/STEAMBALANCE/booster-plugins
- `@steambalance/booster-framework` — зависимость плагинов; подтягивается из реестра
  пакетов через `bun install` (шаблон уже предзаведён с этой зависимостью,
  см. Getting Started).
