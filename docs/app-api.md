# `sb.app` API

`sb.app` provides install-level information about the SteamBooster instance.
It is **ungated** — no `Capability` entry is required; the namespace is
always available inside `ctx.sb.app` regardless of the plugin's declared
capabilities.

## `getSetupId(): Promise<string | undefined>`

Returns the injector's persistent install token (a UUID written to the
Windows registry on first launch and preserved across uninstalls). Useful
for metrics, analytics, and support-case binding without relying on Steam
account identity.

```ts
const id = await ctx.sb.app.getSetupId();
if (id) {
  // id is a UUID string, e.g. "a1b2c3d4-..."
}
```

**Guarantees:**
- Never rejects. Returns `undefined` if the native side cannot provide the
  value (registry locked/unavailable, bridge failure, or a development
  environment without a real injector).
- The UUID is stable per install on a given machine. It changes only if the
  user manually removes the registry key or performs a clean reinstall.
- The value is never logged by the framework. Plugins that store or transmit
  it must treat it as a pseudonymous identifier and follow applicable
  privacy obligations.

## Interface

```ts
interface AppApi {
  /** Persistent per-install token (UUID), or undefined if unavailable. */
  getSetupId(): Promise<string | undefined>;
}
```

## See also

- [`./plugin-contract.md`](./plugin-contract.md) — full `SbApi` surface and
  capability gating rules.
- [`./capabilities.md`](./capabilities.md) — list of gated capabilities
  (`sb.app` is not on this list — it is always available).
