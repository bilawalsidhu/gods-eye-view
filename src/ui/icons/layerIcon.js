/**
 * LayerIcon — inline Lucide SVG icons for every UI surface that used to render
 * an emoji or a text glyph (triangles, bullets, play marks and the like).
 *
 * One outline family, one contract: a 24-unit grid, 1.75px round strokes and
 * `currentColor`, so an icon takes the colour of the text around it — the
 * brand green (`--od-green-500`) on a live DATA LAYERS row, the row's status
 * colour when the feed is stale / degraded / unavailable, the muted neutral
 * when a layer is off (src/ui/styles/icons.css). Icon names are Lucide names
 * declared in src/ui/icons/lucide-manifest.json; the markup comes from the
 * generated registry, so the same module serves the browser and Node tests.
 *
 * Accessibility: an icon that stands alone (an icon-only control without its
 * own aria-label, a status dot) is passed a `label` and renders `role="img"`,
 * `aria-label` and a `<title>`; an icon next to a visible label — or inside a
 * control that already carries `aria-label` — is decorative and renders
 * `aria-hidden="true"` with no `<title>`, so the label is read exactly once.
 *
 * Nothing here ever falls back to a glyph: an unknown name renders the
 * generic `layers` icon and warns once, so the boundary test
 * (src/iconGlyphBoundary.test.mjs) is the only place a stray emoji can hide.
 *
 * Evidence and the emoji → icon mapping: docs/brand/ICON_SOURCE.md.
 */
import { LUCIDE_ICONS, LUCIDE_VERSION } from './lucideIcons.generated.js';

export { LUCIDE_VERSION };
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const ICON_FALLBACK = 'layers';
/** Class every inline icon carries; `od-icon--solid` fills it (HUD REC dot). */
export const ICON_CLASS = 'od-icon';

/** Rendered stroke: a touch lighter than the 2px files so 18px icons sit with the UI's hairlines. */
export const ICON_STROKE_WIDTH = '1.75';
const ROOT_ATTRIBUTES = Object.freeze({
  xmlns: SVG_NS,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': ICON_STROKE_WIDTH,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
});
const warned = new Set();

/** Every registered icon name, in manifest order. */
export function iconNames() {
  return Object.keys(LUCIDE_ICONS);
}

/** Whether `name` is a registered Lucide icon. */
export function hasIcon(name) {
  return (
    typeof name === 'string' &&
    Object.prototype.hasOwnProperty.call(LUCIDE_ICONS, name)
  );
}

/**
 * Resolve a requested icon to a registered name. A legacy glyph or an unknown
 * name resolves to the generic fallback and warns once per value.
 * @param {string} name Requested Lucide icon name.
 * @returns {string} Registered icon name.
 */
export function resolveIconName(name) {
  if (hasIcon(name)) return name;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(
      `[icons] "${String(name)}" is not a registered Lucide icon; rendering "${ICON_FALLBACK}"`,
    );
  }
  return ICON_FALLBACK;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function classAttribute(name, className) {
  return [ICON_CLASS, `${ICON_CLASS}--${name}`, className]
    .filter(Boolean)
    .join(' ');
}

/**
 * Inline `<svg>` markup for templates and `innerHTML` fragments.
 * @param {string} name Lucide icon name.
 * @param {{label?: string, className?: string, size?: number}} [options]
 *   `label` — accessible name for a standalone icon (adds `role="img"`,
 *   `aria-label` and `<title>`); omit it when a visible label or the host
 *   control's `aria-label` already names the control. `size` — explicit
 *   pixel width/height; by default the icon is `1em` (see icons.css).
 * @returns {string} SVG markup.
 */
export function iconMarkup(name, { label = '', className = '', size } = {}) {
  const icon = resolveIconName(name);
  const attributes = { ...ROOT_ATTRIBUTES, 'data-icon': icon };
  attributes.class = classAttribute(icon, className);
  if (Number.isFinite(size) && size > 0) {
    attributes.width = String(size);
    attributes.height = String(size);
  }
  if (label) {
    attributes.role = 'img';
    attributes['aria-label'] = label;
  } else {
    attributes['aria-hidden'] = 'true';
    attributes.focusable = 'false';
  }
  const head = Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(' ');
  const title = label ? `<title>${escapeAttribute(label)}</title>` : '';
  return `<svg ${head}>${title}${LUCIDE_ICONS[icon]}</svg>`;
}

/**
 * Build a live `<svg>` element.
 * @param {string} name Lucide icon name.
 * @param {{label?: string, className?: string, size?: number}} [options]
 * @param {Document} [documentRef] Owning document (defaults to the global).
 * @returns {SVGSVGElement|null} The element, or null when the document cannot
 *   create namespaced elements (the minimal DOM stand-ins used by unit tests).
 */
export function createIcon(name, options = {}, documentRef = globalDocument()) {
  if (!documentRef || typeof documentRef.createElementNS !== 'function')
    return null;
  const icon = resolveIconName(name);
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries(ROOT_ATTRIBUTES))
    svg.setAttribute(key, value);
  svg.setAttribute('class', classAttribute(icon, options.className));
  svg.setAttribute('data-icon', icon);
  if (Number.isFinite(options.size) && options.size > 0) {
    svg.setAttribute('width', String(options.size));
    svg.setAttribute('height', String(options.size));
  }
  svg.innerHTML = LUCIDE_ICONS[icon];
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
    const title = documentRef.createElementNS(SVG_NS, 'title');
    title.textContent = options.label;
    svg.insertBefore(title, svg.firstChild);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  return svg;
}

/**
 * Replace an element's content with an icon, optionally followed by visible
 * text (a former "play-glyph PLAY" label becomes an inline play icon plus
 * "PLAY"). With text present
 * the icon is decorative; without it, `label` names the icon unless the host
 * control already has an `aria-label`. Falls back to text only where SVG
 * elements cannot be created.
 * @param {Element} element Host element (a button, a span).
 * @param {string} name Lucide icon name.
 * @param {{text?: string, label?: string, className?: string, size?: number}} [options]
 * @param {Document} [documentRef]
 * @returns {SVGSVGElement|null} The rendered icon, when one was rendered.
 */
export function setIconContent(
  element,
  name,
  { text = '', label = '', className = '', size } = {},
  documentRef = globalDocument(),
) {
  if (!element) return null;
  const resolved = resolveIconName(name);
  // Idempotent: a sync that runs every frame must not rebuild an unchanged
  // icon (and must not drop keyboard focus inside the host by churning it).
  const existing = renderedIcon(element, resolved, text);
  if (existing) return existing;
  const hostLabelled =
    typeof element.getAttribute === 'function' &&
    Boolean(element.getAttribute('aria-label'));
  const icon = createIcon(
    name,
    { label: text || hostLabelled ? '' : label, className, size },
    documentRef,
  );
  if (
    icon &&
    typeof element.replaceChildren === 'function' &&
    (!text || typeof documentRef.createTextNode === 'function')
  ) {
    const children = [icon];
    if (text) children.push(documentRef.createTextNode(` ${text}`));
    element.replaceChildren(...children);
    return icon;
  }
  element.textContent = text;
  return null;
}

/**
 * Append a decorative icon after an element's existing text ("GET KEY" plus
 * an external-link mark), separated by a space. A no-op where SVG elements
 * cannot be created.
 * @param {Element} element Host element.
 * @param {string} name Lucide icon name.
 * @param {{className?: string, size?: number}} [options]
 * @param {Document} [documentRef]
 * @returns {SVGSVGElement|null} The appended icon, when one was rendered.
 */
export function appendIcon(
  element,
  name,
  options = {},
  documentRef = globalDocument(),
) {
  const icon = createIcon(name, { ...options, label: '' }, documentRef);
  if (!icon || !element || typeof element.append !== 'function') return null;
  if (typeof documentRef.createTextNode === 'function')
    element.append(documentRef.createTextNode(' '));
  element.append(icon);
  return icon;
}

/** The already-rendered icon when `element` holds exactly `icon` (+ `text`). */
function renderedIcon(element, icon, text) {
  const nodes = element.childNodes;
  if (!nodes || nodes.length !== (text ? 2 : 1)) return null;
  const [first, second] = nodes;
  if (
    !first ||
    typeof first.getAttribute !== 'function' ||
    first.getAttribute('data-icon') !== icon
  )
    return null;
  if (text && second?.nodeValue !== ` ${text}`) return null;
  return first;
}

function globalDocument() {
  return typeof document === 'undefined' ? null : document;
}
