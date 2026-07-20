// Family View (parental controls) state, read from the Steam client.
//
// Steam exposes this only as a subscription, never as a getter:
//   SteamClient.Parental.RegisterForParentalSettingsChanges(cb) -> { unregister }
// The callback fires immediately with current settings (verified against the
// live client), so a bounded one-shot read is enough. SharedJSContext only —
// SteamClient does not exist in web targets.

import type { ParentalState } from '../api/api-types';
export type { ParentalState };

interface RawSettings { ever_enabled?: boolean; locked?: boolean }
interface Registration { unregister?: () => void }
type Register = (cb: (s: RawSettings | null) => void) => Registration | undefined;

function getRegister(): Register | undefined {
  try {
    const w = typeof window !== 'undefined' ? (window as unknown as {
      SteamClient?: { Parental?: { RegisterForParentalSettingsChanges?: Register } };
    }) : undefined;
    const fn = w?.SteamClient?.Parental?.RegisterForParentalSettingsChanges;
    return typeof fn === 'function' ? fn : undefined;
  } catch { return undefined; }
}

/** Current Family View state, or undefined when it can't be determined
 *  (not in SharedJSContext, API missing, or no callback within timeoutMs).
 *  Never throws. undefined means UNKNOWN — do not treat it as "unlocked". */
export async function readParentalState(timeoutMs = 1500): Promise<ParentalState | undefined> {
  const register = getRegister();
  if (!register) return undefined;
  return await new Promise<ParentalState | undefined>((resolve) => {
    let done = false;
    let reg: Registration | undefined;
    // Steam fires the callback SYNCHRONOUSLY inside register(), before it
    // returns — so finish() can run while `reg` is still unassigned. Defer the
    // unregister to just after assignment instead of leaking the subscription.
    let unregisterPending = false;
    const unregister = (): void => {
      try { reg?.unregister?.(); } catch { /* best-effort */ }
    };
    const finish = (v: ParentalState | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (reg) unregister(); else unregisterPending = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      reg = register((s) => finish({ everEnabled: !!s?.ever_enabled, locked: !!s?.locked }));
    } catch { finish(undefined); }
    // Runs whether register() returned or threw AFTER firing synchronously —
    // in the throw case `reg` stays unset and the subscription would leak.
    if (unregisterPending) unregister();
  });
}
