// Стратегия поиска Steam header (Spike-4 + reference prototype):
// PRIMARY: .avatarHolder (профиль) → walk-up до родителя с >=3 .Focusable детьми = toolbar.
//   Это структурный приём, переживает CSS-modules рестайлинг лучше чем класс-префиксы.
// FALLBACK: классические class-prefix selectors на случай если структура поменяется.

const STRUCTURAL = '.avatarHolder';

const FALLBACK_SELECTORS: ReadonlyArray<string> = [
  '[class*="topbar_TopBar_"]',
  '[class*="topbar_Topbar_"]',
  '[class^="topbar_"]',
  'header[role="banner"]',
] as const;

export function findToolbar(): HTMLElement | null {
  const avatar = document.querySelector(STRUCTURAL);
  if (avatar) {
    const focusable = avatar.closest('.Focusable');
    const parent = focusable?.parentElement;
    if (parent && parent.querySelectorAll(':scope > .Focusable').length >= 3) {
      return parent as HTMLElement;
    }
  }
  for (const sel of FALLBACK_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

export async function waitForToolbar(timeoutMs = 10000): Promise<HTMLElement | null> {
  const found = findToolbar();
  if (found) return found;

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = findToolbar();
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
