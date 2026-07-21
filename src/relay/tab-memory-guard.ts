// Steam's main window remembers the last URL of each nav tab (store / community
// / me) in MWBM.m_lastActiveTabURLs, keyed by MWBM.GetTabForURL(url):
//   store.steampowered.com/* → "store"   steamcommunity.com/* → "community"
//   the profile route         → "me"      everything else       → "maintain"
// "maintain" means "keep the active tab, but record this URL as its last page".
// So navigating the main window to one of OUR external pages (rate-account,
// catalogue) — which classify "maintain" — writes our URL into the active tab's
// slot. Steam's own Store/Community buttons then reload OUR page instead of the
// store. Both entry points (supernav openUrl→ShowURL, store-nav location.assign)
// funnel through MWBM.OnStartRequest → UpdateActiveTab → GetTabForURL, so one
// wrap fixes both.
//
// Verified against the live client: GetTabForURL is called ONLY from
// UpdateActiveTab, so reclassifying its result cannot affect actual navigation.

// Suffix match: help.steampowered.com and store.steampowered.com are both Steam.
const STEAM_HOST_SUFFIXES = [
  'steampowered.com',
  'steamcommunity.com',
  'steamstatic.com',
  'valvesoftware.com',
  'steamloopback.host',
];

function isSteamHost(host: string): boolean {
  const h = host.toLowerCase();
  return STEAM_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

interface TabMwbm {
  GetTabForURL?: (url: string) => string;
  m_lastActiveTabURLs?: Record<string, string>;
  m_rootTabURLs?: Record<string, string>;
  __sb_tab_guard?: boolean;
}

/** Wrap MWBM.GetTabForURL so external "maintain" pages (ours, payment redirects)
 *  classify as "ignore" and stop clobbering Steam's per-tab memory; Steam hosts
 *  keep their behavior. Then heal any tab already clobbered by an external page.
 *  Idempotent, never throws. */
export function installTabMemoryGuard(mwbm: TabMwbm | undefined | null): void {
  if (!mwbm || typeof mwbm.GetTabForURL !== 'function') return;

  if (!mwbm.__sb_tab_guard) {
    const orig = mwbm.GetTabForURL.bind(mwbm);
    mwbm.GetTabForURL = (url: string): string => {
      const tab = orig(url);
      if (tab === 'maintain') {
        try {
          if (!isSteamHost(new URL(url).host)) return 'ignore';
        } catch { /* not a parseable URL (e.g. a Steam route name) — leave it */ }
      }
      return tab;
    };
    mwbm.__sb_tab_guard = true;
  }

  // Heal tabs whose remembered URL is an external page we clobbered before the
  // guard existed: DELETE the slot. Clean Steam has no entry for an unvisited
  // tab and resolves its root from m_rootTabURLs, so deleting restores exactly
  // that — clicking the tab returns the real store/community page. Do NOT write
  // the root id here: m_lastActiveTabURLs holds real URLs, and a route id like
  // "StoreFrontPage" loads as http://storefrontpage/ (net error -105). A tab
  // holding a genuine Steam URL classifies store/community (not ignore) and is
  // left alone.
  try {
    const active = mwbm.m_lastActiveTabURLs;
    if (active) {
      for (const tab of Object.keys(active)) {
        if (mwbm.GetTabForURL!(active[tab]!) === 'ignore') delete active[tab];
      }
    }
  } catch { /* best-effort */ }
}
