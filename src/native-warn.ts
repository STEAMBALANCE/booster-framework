// Single shared shim for "log a one-line warn from a no-bridge context".
//
// Sends a fire-and-forget notify envelope to the C++ log op:
//   { op: 'log', kind: 'notify', pluginId: 'booster-framework',
//     args: { level, msg, meta } }
// The op reads args.level / args.msg / args.meta and requires a valid
// envelope-level pluginId; 'booster-framework' satisfies the plugin-id rule.
// notify means no __sb_resolve reply is expected.
//
// Why this is a separate module: bootstrap (index.ts), lifecycle.ts and the
// relay (relay/shared-context.ts) all needed the same shape, and three
// copy-pasted versions are exactly what one shared module is for. Keep this
// file dependency-free — it must be safe to call before bridge.ts has been
// constructed (every other module here can fail in interesting ways at
// boot, this one cannot).

export function nativeWarn(message: string, context: Record<string, unknown> = {}): void {
  try {
    const native = (window as unknown as { __sb_native?: (s: string) => void }).__sb_native;
    if (typeof native === 'function') {
      native(JSON.stringify({
        op: 'log',
        kind: 'notify',
        pluginId: 'booster-framework',
        args: { level: 'warn', msg: message, meta: context },
      }));
    }
  } catch { /* swallow — can't log if bridge is broken */ }
}
