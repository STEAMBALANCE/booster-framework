// Shared SVG sanitiser for icon strings passed through Capability.Ui surfaces.
// Extracted from relay/menu-items.ts so the store-supernav dropdown items
// (relay realm) AND the store-nav bar button (store Web realm) sanitise
// identically. `doc` is REQUIRED and cross-realm by design: DOMParser runs in
// the caller's realm; the sanitised tree is built with the DESTINATION doc's
// createElementNS. Conservative allowlist — enough for flat icon marks,
// nothing scriptable; ref-based tags (defs/use/mask/…) are excluded (their
// only use is url(#id) refs, which the value filter strips anyway).

const SVG_NS = 'http://www.w3.org/2000/svg';

const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'title', 'desc',
]);
const SVG_ALLOWED_ATTRS = new Set([
  'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'fill-rule', 'clip-rule',
  'viewbox', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'opacity', 'fill-opacity',
  'stroke-opacity', 'aria-hidden', 'xmlns', 'preserveaspectratio',
]);

export function sanitizeIconSvg(svg: string, doc: Document): Element | null {
  let parsed: Document;
  try { parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'); }
  catch { return null; }
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  if (parsed.getElementsByTagName('parsererror').length > 0) return null;

  const clean = (src: Element): Element | null => {
    const tag = src.tagName.toLowerCase();
    if (!SVG_ALLOWED_TAGS.has(tag)) return null;
    const el = doc.createElementNS(SVG_NS, tag);
    for (const attr of Array.from(src.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) continue;
      if (!SVG_ALLOWED_ATTRS.has(name)) continue;
      if (/url\(|javascript:|expression\(/i.test(attr.value)) continue;
      el.setAttribute(attr.name, attr.value);
    }
    for (const child of Array.from(src.children)) {
      const c = clean(child);
      if (c) el.appendChild(c);
    }
    return el;
  };
  return clean(root);
}
