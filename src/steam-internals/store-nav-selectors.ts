// Durable, layout-independent anchor for the Steam store top-nav bar (the row
// of flyout tabs «Просмотр / Рекомендации / Категории …»). The row's class is a
// hashed CSS-module name that changes on Steam rebuilds, and the strip
// re-renders (tabs collapse into «Прочее» on narrow widths), so we anchor
// STRUCTURALLY — not on classes, text, or geometry:
//   - tab button = <button aria-expanded> containing a caret <svg>
//   - row = the parent shared by the MOST such buttons (the strip has 3-5;
//     account/language pulldowns are singletons under other parents)
//   - tie-breaks: (1) group whose tab buttons share one identical className
//     (the real strip), (2) first group in document order
// getBoundingClientRect is deliberately unused: happy-dom returns zeros, and a
// pre-layout/display:none row would report top:0 and mis-pick on tick 1.

export function findStoreNav(): HTMLElement | null {
  const tabs = Array.from(document.querySelectorAll('button[aria-expanded]'))
    .filter((b): b is HTMLButtonElement => !!b.querySelector('svg'));
  if (tabs.length === 0) return null;

  // Group by parent, preserving document order of first appearance.
  const order: HTMLElement[] = [];
  const byParent = new Map<HTMLElement, HTMLButtonElement[]>();
  for (const b of tabs) {
    const p = b.parentElement as HTMLElement | null;
    if (!p) continue;
    let arr = byParent.get(p);
    if (!arr) { arr = []; byParent.set(p, arr); order.push(p); }
    arr.push(b);
  }
  const candidates = order
    .map((p) => ({ parent: p, children: byParent.get(p)! }))
    .filter((g) => g.children.length >= 2);
  if (candidates.length === 0) return null;

  const maxCount = Math.max(...candidates.map((g) => g.children.length));
  const top = candidates.filter((g) => g.children.length === maxCount);
  if (top.length === 1) return top[0]!.parent;

  const shared = top.find((g) => {
    const c0 = g.children[0]!.className;
    return !!c0 && g.children.every((b) => b.className === c0);
  });
  return (shared ?? top[0]!).parent;
}
