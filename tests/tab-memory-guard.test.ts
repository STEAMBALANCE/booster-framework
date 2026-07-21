// Steam remembers the last URL per nav tab (store/community/me) in
// MWBM.m_lastActiveTabURLs, keyed by MWBM.GetTabForURL. Our own pages (and
// payment redirects) classify as "maintain", which Steam writes into the ACTIVE
// tab's slot — so clicking Steam's own Store/Community button then reloads OUR
// page. The guard reclassifies external "maintain" pages as "ignore" so they
// don't clobber tab memory, and heals tabs already clobbered.
import { test, expect, describe } from 'bun:test';
import { installTabMemoryGuard } from '../src/relay/tab-memory-guard';

function makeMwbm(lastActive: Record<string, string> = {}) {
  return {
    m_rootTabURLs: { store: 'StoreFrontPage', community: 'CommunityFrontPage', me: 'SteamIDMyProfile' } as Record<string, string>,
    m_lastActiveTabURLs: { ...lastActive } as Record<string, string>,
    // Mirror the live client: store/community by prefix, everything else
    // (help, our pages, payment) → "maintain".
    GetTabForURL(url: string): string {
      if (url.startsWith('https://store.steampowered.com')) return 'store';
      if (url.startsWith('https://steamcommunity.com')) return 'community';
      return 'maintain';
    },
  };
}

describe('installTabMemoryGuard', () => {
  test('external maintain page (ours) reclassifies to ignore', () => {
    const m = makeMwbm();
    installTabMemoryGuard(m as never);
    expect(m.GetTabForURL('https://steambalance.cc/booster/viral')).toBe('ignore');
  });

  test('payment-redirect maintain page reclassifies to ignore', () => {
    const m = makeMwbm();
    installTabMemoryGuard(m as never);
    expect(m.GetTabForURL('https://securepay.tinkoff.ru/x')).toBe('ignore');
  });

  test('a Steam host that is "maintain" (help) is left untouched', () => {
    const m = makeMwbm();
    installTabMemoryGuard(m as never);
    expect(m.GetTabForURL('https://help.steampowered.com/')).toBe('maintain');
  });

  test('store / community classifications are unchanged', () => {
    const m = makeMwbm();
    installTabMemoryGuard(m as never);
    expect(m.GetTabForURL('https://store.steampowered.com/app/730/')).toBe('store');
    expect(m.GetTabForURL('https://steamcommunity.com/market/')).toBe('community');
  });

  test('non-URL argument falls through to the original result (no throw)', () => {
    const m = makeMwbm();
    installTabMemoryGuard(m as never);
    expect(() => m.GetTabForURL('StoreFrontPage')).not.toThrow();
    expect(m.GetTabForURL('StoreFrontPage')).toBe('maintain'); // orig result preserved
  });

  test('idempotent — installing twice does not double-wrap', () => {
    const m = makeMwbm();
    installTabMemoryGuard(m as never);
    const afterFirst = m.GetTabForURL;
    installTabMemoryGuard(m as never);
    expect(m.GetTabForURL).toBe(afterFirst);
  });

  // Clean Steam has no entry for an unvisited tab — it resolves the tab's root
  // from m_rootTabURLs. So healing must DELETE a clobbered slot, not write the
  // route id ("StoreFrontPage") as a URL (which loads as http://storefrontpage/
  // → net error -105). Verified against a fresh Steam restart.
  test('heals tabs already clobbered by our pages → deletes the slot', () => {
    const m = makeMwbm({
      store: 'https://steambalance.cc/booster/viral',
      community: 'https://steambalance.cc/booster/catalogue',
      me: 'https://steamcommunity.com/id/someone',   // a real Steam URL — must NOT be healed
    });
    installTabMemoryGuard(m as never);
    expect('store' in m.m_lastActiveTabURLs).toBe(false);       // deleted → Steam resolves root
    expect('community' in m.m_lastActiveTabURLs).toBe(false);   // deleted
    expect(m.m_lastActiveTabURLs['me']).toBe('https://steamcommunity.com/id/someone'); // untouched
  });

  test('a real store URL still updates the store tab after the guard', () => {
    const m = makeMwbm({ store: 'https://steambalance.cc/booster/viral' });
    installTabMemoryGuard(m as never);
    // Simulate Steam's UpdateActiveTab for a genuine store nav.
    if (m.GetTabForURL('https://store.steampowered.com/app/730/') !== 'ignore') {
      m.m_lastActiveTabURLs['store'] = 'https://store.steampowered.com/app/730/';
    }
    expect(m.m_lastActiveTabURLs['store']).toBe('https://store.steampowered.com/app/730/');
  });

  test('no MWBM / no GetTabForURL → no-op, never throws', () => {
    expect(() => installTabMemoryGuard(undefined as never)).not.toThrow();
    expect(() => installTabMemoryGuard({} as never)).not.toThrow();
  });
});
