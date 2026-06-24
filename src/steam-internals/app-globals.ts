/** Type-safe sync accessor for App.m_cm.m_strPersonaName.
 *
 *  Background: Steam exposes personaName via two unrelated globals:
 *    - `SteamClient.User.RegisterForCurrentUserChanges` callback snapshot
 *      (does NOT include personaName — only strAccountName/strSteamID/etc).
 *    - `App.m_cm.m_strPersonaName` synchronous global (populated by
 *      Steam's CM after login completes).
 *
 *  This accessor is called on every RegisterForCurrentUserChanges callback
 *  in the relay's user-change listener, and the result is included in the
 *  diff comparison — so when Steam's CM populates the persona later
 *  (asynchronously), the next callback fires and broadcasts a fresh snapshot.
 *
 *  Returns undefined if App.m_cm doesn't exist or persona is empty. */

declare global {
  interface Window {
    App?: {
      m_cm?: {
        m_strPersonaName?: unknown;
      };
    };
  }
}

export function readPersonaNameSync(): string | undefined {
  const v = window.App?.m_cm?.m_strPersonaName;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
