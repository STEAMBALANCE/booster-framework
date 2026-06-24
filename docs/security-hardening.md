# Security hardening notes

## Plugin global API

`window.sb` is only a registration facade: `version`, `state`, and
`plugins.register/ready`. Privileged APIs are passed to plugin `init()` through
`PluginContext.sb` after manifest validation and capability intersection.

## Relay authentication

The relay supports an optional `__SB_RELAY_TOKEN__` injected by the native
loader into both MainShell and SharedJSContext. When present, SharedJSContext
ignores command messages that do not carry this token.

Native loader requirement:

1. Generate a fresh high-entropy token per SteamBooster process/session.
2. Inject it before the framework runs in every context that participates in
   `BroadcastChannel('sb_cmd')`.
3. Do not expose it through plugin manifests, config, logs, or public APIs.

Without the native token, the framework keeps backward-compatible behavior.
This mode is not a complete security boundary for untrusted plugins.
