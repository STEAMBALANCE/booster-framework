// One tooltip element shared by every booster-* button on the page. Steam's own
// tooltip system also uses a single DOM element re-positioned per hover —
// keeps the DOM cheap and avoids races where two tooltips fight to show.
const SB_TOOLTIP_ID = '__sb_toolbar_tooltip';
const SB_TOOLTIP_DELAY_MS = 300;  // matches Steam's nDelayShowMS default

interface TooltipState {
  el: HTMLElement;
  showTimer: ReturnType<typeof setTimeout> | null;
}
let tooltipState: TooltipState | null = null;

function ensureTooltipEl(): HTMLElement {
  // Per-Window singleton; reset if the prior reference has been detached
  // (e.g. document.body re-rendered by Steam — rare but observed).
  if (tooltipState && tooltipState.el.isConnected) return tooltipState.el;
  let el = document.getElementById(SB_TOOLTIP_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = SB_TOOLTIP_ID;
    el.className = 'booster-tooltip';
    document.body.appendChild(el);
  }
  tooltipState = { el, showTimer: null };
  return el;
}

export function wireTooltip(button: HTMLElement, text: string): () => void {
  // Returns an undo for registry — clears the timer + hides the tooltip
  // if it's currently showing for THIS button. Handler-style closures so
  // we can removeEventListener on rollback without leaking.
  const onEnter = (): void => {
    const t = ensureTooltipEl();
    if (tooltipState!.showTimer) clearTimeout(tooltipState!.showTimer);
    tooltipState!.showTimer = setTimeout(() => {
      t.textContent = text;
      // Pre-position offscreen to measure, then place. Two passes are
      // needed because the tooltip's width depends on the (just-set)
      // text and we want to center it under the button.
      t.style.left = '-10000px';
      t.style.top = '0px';
      t.setAttribute('data-booster-tooltip-show', '1');
      const tr = t.getBoundingClientRect();
      const br = button.getBoundingClientRect();
      const left = Math.round(br.left + br.width / 2 - tr.width / 2);
      const top = Math.round(br.bottom + 6);
      // Clamp horizontally so the tooltip never spills off-screen.
      const maxLeft = Math.max(0, window.innerWidth - tr.width - 4);
      t.style.left = Math.max(4, Math.min(left, maxLeft)) + 'px';
      t.style.top = top + 'px';
    }, SB_TOOLTIP_DELAY_MS);
  };
  const onLeave = (): void => {
    if (tooltipState && tooltipState.showTimer) {
      clearTimeout(tooltipState.showTimer);
      tooltipState.showTimer = null;
    }
    if (tooltipState) tooltipState.el.removeAttribute('data-booster-tooltip-show');
  };
  button.addEventListener('mouseenter', onEnter);
  button.addEventListener('mouseleave', onLeave);
  // mousedown should hide too — once the user clicks, the click target
  // is doing something (popup show/hide) and the tooltip lingering is
  // distracting. mouseleave will fire on Steam's popup-open path
  // anyway, but mousedown is the more precise signal.
  button.addEventListener('mousedown', onLeave);
  return () => {
    button.removeEventListener('mouseenter', onEnter);
    button.removeEventListener('mouseleave', onLeave);
    button.removeEventListener('mousedown', onLeave);
    onLeave();
  };
}
