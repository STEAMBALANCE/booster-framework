// Structural locator for the Steam client supernav (the top main-nav row:
// Магазин · Библиотека · Сообщество · <НИК>). NEVER keys off Steam's hashed
// CSS-module classes/ids — anchors on the <НИК> tab, matched by persona OR
// account name (both learned from the user snapshot). Layout-independent:
// MUST NOT use getBoundingClientRect (happy-dom returns zero rects).

export interface SuperNavAnchor {
  container: HTMLElement;
  anchorTab: HTMLElement;
}

// A supernav tab is a leaf-ish element (0-1 element children) with non-empty
// text (Магазин, the <НИК> tab, …). The container's leading svg icons have
// empty text and are excluded.
function isTabLike(el: Element): boolean {
  return el.childElementCount <= 1 && (el.textContent ?? '').trim().length > 0;
}

export function findSuperNav(
  names: { personaName?: string; accountName?: string },
): SuperNavAnchor | null {
  const candidates = [names.personaName, names.accountName]
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0);
  if (candidates.length === 0) return null; // no structural fallback by design

  // Document order → the topmost matching <НИК> tab wins. We scan leaf-ish
  // nodes whose exact trimmed text is a candidate name.
  const nodes = document.querySelectorAll<HTMLElement>('div, span, a');
  for (const el of nodes) {
    if (el.childElementCount > 1) continue;
    const txt = (el.textContent ?? '').trim();
    if (!candidates.includes(txt)) continue;

    // Walk up a few levels: the supernav container is the ancestor whose
    // DIRECT children include our tab plus >= 2 other tab-like siblings
    // (Магазин/Библиотека/Сообщество), >= 3 element children total.
    let node: HTMLElement | null = el;
    for (let depth = 0; depth < 4 && node; depth++) {
      const container: HTMLElement | null = node.parentElement;
      if (container && container.childElementCount >= 3) {
        let others = 0;
        for (const k of Array.from(container.children)) {
          if (k !== node && isTabLike(k)) others++;
        }
        if (others >= 2) return { container, anchorTab: node };
      }
      node = node.parentElement;
    }
  }
  return null;
}
