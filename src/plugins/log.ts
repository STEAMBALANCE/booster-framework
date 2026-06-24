import type { LogApi } from '../api/api-types';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type NotifyFn = (op: string, pluginId: string, args: unknown) => void;

const RATE_LIMIT_PER_SEC = 200;
const WINDOW_MS = 1000;

/**
 * Build a per-plugin LogApi that emits 'log' notify-envelope to bridge,
 * with client-side rate limiting (200/sec sliding window). C++ side has
 * additional 100/sec rate limit.
 *
 * Non-serializable meta is silently dropped (no throw to plugin).
 */
export function createPluginLog(pluginId: string, notify: NotifyFn): LogApi {
  const timestamps: number[] = [];

  function checkRate(): boolean {
    const now = Date.now();
    // Drop entries older than 1 sec.
    while (timestamps.length > 0 && timestamps[0] < now - WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length >= RATE_LIMIT_PER_SEC) {
      return false;
    }
    timestamps.push(now);
    return true;
  }

  function emit(level: Level, msg: string, meta?: object): void {
    if (!checkRate()) return;
    if (meta !== undefined) {
      try {
        // Defensive serialization check; circular refs throw.
        JSON.stringify(meta);
      } catch {
        return;  // silently drop non-serializable
      }
    }
    notify('log', pluginId, { level, msg, meta });
  }

  return {
    trace: (msg, meta) => emit('trace', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
    info:  (msg, meta) => emit('info',  msg, meta),
    warn:  (msg, meta) => emit('warn',  msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}
