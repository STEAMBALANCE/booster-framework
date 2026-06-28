import {
  Capability,
  type SbApi,
} from '../api/api-types';

export interface GlobalSbApi {
  readonly version: SbApi['version'];
  readonly state: SbApi['state'];
  readonly plugins: SbApi['plugins'];
}

export function buildGlobalSb(real: SbApi): GlobalSbApi {
  return {
    version: real.version,
    get state() { return real.state; },
    plugins: real.plugins,
  };
}

/**
 * Build a capability-gated view of the framework's SbApi for plugin use.
 *
 * Always-available modules (no gating): version, state, context, lifecycle,
 * scope, plugins, app.
 *
 * Capability-gated modules: ui, steam, configs, bus, pages, keys —
 * present only if in the `granted` set.
 *
 * Note: types are widened with `as never` because TS makes optional
 * conditional-typing awkward; runtime, the gated modules are simply
 * absent (undefined) when not granted. Plugin author should check
 * `ctx.granted.has(Capability.X)` before using.
 */
export function buildGatedSb(real: SbApi, granted: ReadonlySet<Capability>): SbApi {
  return {
    version: real.version,
    // Forward the live value so plugins observe loading → ready transitions
    // (a by-value snapshot would freeze whatever state existed at build time).
    get state() { return real.state; },
    context: real.context,
    app: real.app,
    lifecycle: real.lifecycle,
    scope: real.scope,
    plugins: real.plugins,
    ui:      granted.has(Capability.Ui)      ? real.ui      : (undefined as never),
    steam:   granted.has(Capability.Steam)   ? real.steam   : (undefined as never),
    configs: granted.has(Capability.Configs) ? real.configs : (undefined as never),
    bus:     granted.has(Capability.Bus)     ? real.bus     : (undefined as never),
    pages:   granted.has(Capability.Pages)   ? real.pages   : (undefined as never),
    keys:    granted.has(Capability.Keys)    ? real.keys    : (undefined as never),
  };
}
