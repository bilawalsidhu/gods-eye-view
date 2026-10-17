// Small DOM helpers for the ORYN shell. Text always goes through
// `textContent`; markup is only built from these helpers, never from
// string concatenation of untrusted data.

/**
 * Create an element.
 * @param {string} tag
 * @param {object} [props] className, attrs, dataset, text, on, children
 * @param {...(Node|string|null|undefined|false)} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { className, attrs, dataset, text, on, html } = props || {};
  if (className) node.className = className;
  if (attrs)
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  if (dataset)
    for (const [key, value] of Object.entries(dataset))
      if (value !== null && value !== undefined)
        node.dataset[key] = String(value);
  if (text !== undefined && text !== null) node.textContent = text;
  if (html) node.innerHTML = html;
  if (on)
    for (const [event, handler] of Object.entries(on))
      node.addEventListener(event, handler);
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replaceChildren(node, ...children) {
  clear(node);
  for (const child of children.flat(Infinity)) if (child) node.append(child);
  return node;
}

/** Inline SVG icons (24px grid, stroke-based) used by the ORYN shell. */
const ICON_PATHS = Object.freeze({
  overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  map: 'M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3zm0-13.5v13M15 6v13',
  municipal: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 11h.01M15 11h.01',
  agriculture:
    'M12 22V12M12 12c0-4 3-7 8-7-1 5-4 7-8 7zM12 15c0-4-3-7-8-7 1 5 4 7 8 7z',
  transportation:
    'M3 17h18M5 17V9a2 2 0 012-2h10a2 2 0 012 2v8M7 21h.01M17 21h.01M7 12h10',
  infrastructure:
    'M12 2v4m0 12v4M2 12h4m12 0h4M5.6 5.6l2.8 2.8m7.2 7.2l2.8 2.8M5.6 18.4l2.8-2.8m7.2-7.2l2.8-2.8',
  events: 'M12 3l10 18H2L12 3zm0 7v4m0 3h.01',
  cameras:
    'M4 7h3l2-2h6l2 2h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1zm8 3a3.5 3.5 0 100 7 3.5 3.5 0 000-7z',
  investigations: 'M10 4a6 6 0 100 12 6 6 0 000-12zm5 11l6 6M8 10h4M10 8v4',
  alerts: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zm4 4a2 2 0 004 0',
  reports: 'M6 2h8l6 6v14H6V2zm8 0v6h6M9 13h6M9 17h6',
  sources:
    'M4 6a8 3 0 1016 0 8 3 0 10-16 0zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 00-1.7-1l-.4-2.6H9.2L8.8 6a7.5 7.5 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 001.7 1l.4 2.6h5.6l.4-2.6a7.5 7.5 0 001.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z',
  audit: 'M4 4h16v16H4V4zm4 4h8M8 12h8M8 16h5',
  layers: 'M12 3l9 5-9 5-9-5 9-5zm-9 9l9 5 9-5M3 16l9 5 9-5',
  inspect: 'M3 6h18M3 12h12M3 18h7M17 15l2 2 4-4',
  timeline: 'M3 12h18M7 12V8M12 12V5M17 12V9M7 16h.01M12 16h.01M17 16h.01',
  search: 'M10 4a6 6 0 100 12 6 6 0 000-12zm5 11l6 6',
  close: 'M6 6l12 12M18 6L6 18',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0',
  logout: 'M10 4H5v16h5M14 8l5 4-5 4M19 12H9',
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9z',
  focus: 'M12 8a4 4 0 100 8 4 4 0 000-8zm0-5v3m0 12v3M3 12h3m12 0h3',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7V5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  stepBack: 'M18 5l-9 7 9 7V5zM6 5v14',
  stepForward: 'M6 5l9 7-9 7V5zM18 5v14',
  download: 'M12 4v12m0 0l-4-4m4 4l4-4M4 20h16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4l10-10-4-4L4 16v4zM13 7l4 4',
  pin: 'M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12zm0-9a3 3 0 100-6 3 3 0 000 6z',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  check: 'M5 12l5 5 9-11',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zm0-11v6m0-10h.01',
  warning: 'M12 3l10 18H2L12 3zm0 7v4m0 3h.01',
  globe:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm0 0c3 3 3 17 0 20M12 2c-3 3-3 17 0 20M2 12h20',
  refresh: 'M20 12a8 8 0 01-14 5.3M4 12a8 8 0 0114-5.3M4 4v5h5M20 20v-5h-5',
  menu: 'M4 6h16M4 12h16M4 18h16',
});

/** An inline SVG icon element; decorative by default. */
export function icon(name, { size = 18, label = null } = {}) {
  const path = ICON_PATHS[name] ?? ICON_PATHS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('oryn-icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  const pathNode = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'path',
  );
  pathNode.setAttribute('d', path);
  svg.append(pathNode);
  return svg;
}

export const ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS));

/** A button with an icon and optional text label. */
export function button({
  label,
  iconName,
  className = '',
  title,
  pressed,
  disabled,
  type = 'button',
  onClick,
  dataset,
  attrs,
}) {
  const node = el('button', {
    className: `oryn-btn ${className}`.trim(),
    attrs: {
      type,
      title: title ?? null,
      'aria-label': !label && (title || null),
      'aria-pressed': typeof pressed === 'boolean' ? String(pressed) : null,
      'aria-disabled': disabled ? 'true' : null,
      ...(attrs || {}),
    },
    dataset,
    on: onClick
      ? {
          click: (event) => {
            if (node.getAttribute('aria-disabled') === 'true') {
              event.preventDefault();
              return;
            }
            onClick(event);
          },
        }
      : undefined,
  });
  if (iconName) node.append(icon(iconName));
  if (label)
    node.append(el('span', { className: 'oryn-btn-label', text: label }));
  return node;
}

/** A status chip with an accessible text label; color is secondary. */
export function chip(text, state = 'neutral', { title } = {}) {
  return el('span', {
    className: `oryn-chip oryn-chip-${state}`,
    attrs: { title: title ?? null },
    text,
  });
}

/** Key/value row used by the inspector and detail drawers. */
export function field(label, value, { provenance, mono = true, href } = {}) {
  const valueNode = href
    ? el('a', {
        className: 'oryn-field-value oryn-link',
        attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
        text: value,
      })
    : el('span', {
        className: `oryn-field-value${mono ? ' oryn-mono' : ''}`,
        text: value,
      });
  return el(
    'div',
    {
      className: 'oryn-field',
      dataset: provenance ? { provenance } : undefined,
    },
    el('span', { className: 'oryn-field-label', text: label }),
    valueNode,
  );
}

export function emptyState(title, body, action) {
  return el(
    'div',
    { className: 'oryn-empty' },
    el('p', { className: 'oryn-empty-title', text: title }),
    body ? el('p', { className: 'oryn-empty-body', text: body }) : null,
    action || null,
  );
}

export function formatCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
