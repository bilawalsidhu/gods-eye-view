/**
 * Vertical tab strip for the right context rail: one icon tab per rail
 * panel, the open panel beside the strip, at most one panel open. The panels'
 * `collapsed` classes remain the only state; the strip mirrors them and asks
 * the owner (setPanelCollapsed) for every change, so persistence, share links
 * and the rail layout pass are untouched. Phones hide the strip and keep their
 * sheet shell (mobileShell.js).
 *
 * The open tab and its panel are drawn as one surface by a join element the
 * strip shapes from both (railJoinPath); styles/right-rail-tabs.css has the
 * layers. A tool slot under the tabs holds the compact Radio launcher on
 * desktop (radioPanelPlacement.js).
 */
import { msg, t } from '../i18n/index.js';

/**
 * Marks the rail while its strip is mounted; styles/right-rail-tabs.css keys
 * the tab geometry on it, so a rail without a strip keeps its plain layout.
 */
const RAIL_TABS_ATTRIBUTE = 'data-rail-tabs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Each rail panel's tab glyph (Material Symbols). index.html subsets the icon
 * font, so its `icon_names` must carry every one.
 */
export const RAIL_TAB_ICONS = Object.freeze({
  'pp-toggles': 'tune',
  'cctv-panel': 'videocam',
  'street-level-panel': 'streetview',
  'global-context-panel': 'travel_explore',
  'weather-panel': 'cloud',
  'recent-imagery-panel': 'satellite_alt',
});

/**
 * The tab keyboard navigation moves to in a vertical tablist: Down and Up
 * wrap, Home and End jump. Any other key keeps the current index.
 * @param {string} key KeyboardEvent.key.
 * @param {number} index Index of the focused tab.
 * @param {number} count Visible tab count.
 * @returns {number} Target index, or -1 when there is no tab.
 */
export function nextRailTabIndex(key, index, count) {
  if (!(count > 0)) return -1;
  const current = Math.max(0, Math.min(count - 1, index));
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return current;
  }
}

/**
 * SVG path of the panel with the open tab attached to its right edge, traced
 * clockwise from the top-left corner, in rail pixels.
 *
 * Round: the panel's corners and the tab's outer corners are convex arcs and
 * the two inner corners where the tab's top and bottom edges meet the panel's
 * right edge are concave fillets. A tab level with the panel's top shares its
 * top edge, so that corner and the upper fillet are dropped. Chamfer (Cyber):
 * the frame's 10px chamfers and 6px calibration bay (cyber.css,
 * --cyber-panel-frame) and a square tab. `inset` moves the whole outline
 * inward; 0.5 centres a one-pixel stroke just inside the edge.
 *
 * @param {object} g
 * @param {{x0: number, y0: number, x1: number, y1: number}} g.panel
 * @param {{top: number, bottom: number, right: number}} g.tab The tab's
 *   extent; its left edge is the panel's right edge.
 * @param {number} [g.corner] Panel corner radius, or the chamfer size.
 * @param {number} [g.tabRadius] The tab's outer corner radius.
 * @param {number} [g.fillet] Concave fillet radius at the junction.
 * @param {'round'|'chamfer'} [g.style]
 * @param {number} [g.inset]
 * @returns {string}
 */
export function railJoinPath({
  panel,
  tab,
  corner = 16,
  tabRadius = 10,
  fillet = 8,
  style = 'round',
  inset = 0,
}) {
  const n = (value) => Math.round(value * 100) / 100;
  const P = (x, y) => `${n(x)} ${n(y)}`;
  const x0 = panel.x0 + inset;
  const y0 = panel.y0 + inset;
  const x1 = panel.x1 - inset;
  const y1 = panel.y1 - inset;
  const ty0 = tab.top + inset;
  const ty1 = tab.bottom - inset;
  const tx1 = tab.right - inset;
  if (style === 'chamfer') {
    const c = corner;
    const cx = (panel.x0 + panel.x1) / 2;
    // The tab's edges along the panel stay between the chamfers.
    const tyA = Math.max(ty0, y0 + c);
    const tyB = Math.max(tyA, Math.min(ty1, y1 - c));
    const edge = [
      `L ${P(x1, tyA)}`,
      `L ${P(tx1, tyA)}`,
      `L ${P(tx1, tyB)}`,
      `L ${P(x1, tyB)}`,
    ];
    return [
      `M ${P(x0, y0 + c)}`,
      `L ${P(x0 + c, y0)}`,
      `L ${P(cx - 25, y0)}`,
      `L ${P(cx - 18, y0 + 6)}`,
      `L ${P(cx + 18, y0 + 6)}`,
      `L ${P(cx + 25, y0)}`,
      `L ${P(x1 - c, y0)}`,
      `L ${P(x1, y0 + c)}`,
      ...edge,
      `L ${P(x1, y1 - c)}`,
      `L ${P(x1 - c, y1)}`,
      `L ${P(x0 + c, y1)}`,
      `L ${P(x0, y1 - c)}`,
      'Z',
    ].join(' ');
  }
  const R = Math.max(0, corner - inset);
  const r = Math.max(0, tabRadius - inset);
  const f = fillet + inset;
  const d = [];
  let at = null;
  const same = (x, y) => at && at[0] === n(x) && at[1] === n(y);
  const move = (x, y) => {
    d.push(`M ${P(x, y)}`);
    at = [n(x), n(y)];
  };
  const line = (x, y) => {
    if (same(x, y)) return;
    d.push(`L ${P(x, y)}`);
    at = [n(x), n(y)];
  };
  // sweep 1 turns clockwise (convex), 0 counter-clockwise (concave); a zero
  // radius is a plain corner.
  const arc = (radius, sweep, x, y) => {
    if (!(radius > 0)) return line(x, y);
    d.push(`A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${P(x, y)}`);
    at = [n(x), n(y)];
  };
  // The run of panel edge above or below the tab may be shorter than a fillet
  // plus a corner: shrink them to what fits, down to a straight edge shared
  // with the panel's top or bottom.
  const fit = (room) => {
    const fillet = Math.min(f, Math.max(0, room - R));
    return { fillet, corner: Math.min(R, Math.max(0, room - fillet)) };
  };
  move(x0 + R, y0);
  const first = tab.top - panel.y0 < 0.5;
  const last = panel.y1 - tab.bottom < 0.5;
  const above = fit(ty0 - y0);
  const below = fit(y1 - ty1);
  if (first) {
    line(tx1 - r, y0);
    arc(r, 1, tx1, y0 + r);
  } else {
    line(x1 - above.corner, y0);
    arc(above.corner, 1, x1, y0 + above.corner);
    line(x1, ty0 - above.fillet);
    arc(above.fillet, 0, x1 + above.fillet, ty0);
    line(tx1 - r, ty0);
    arc(r, 1, tx1, ty0 + r);
  }
  line(tx1, ty1 - r);
  arc(r, 1, tx1 - r, ty1);
  if (!last) {
    line(x1 + below.fillet, ty1);
    arc(below.fillet, 0, x1, ty1 + below.fillet);
    line(x1, y1 - below.corner);
    arc(below.corner, 1, x1 - below.corner, y1);
  }
  line(x0 + R, y1);
  arc(R, 1, x0, y1 - R);
  line(x0, y0 + R);
  arc(R, 1, x0 + R, y0);
  d.push('Z');
  return d.join(' ');
}

/** The tab's name: the panel's own header title, already translated. */
function panelTitle(panel) {
  return (
    panel
      .querySelector?.('.panel-title, .pp-header-label')
      ?.textContent?.trim() || panel.id
  );
}

/**
 * Build the strip inside `rail` and keep it in step with the rail's panels.
 * @param {object} input
 * @param {HTMLElement} input.rail The right context rail.
 * @param {(panelId: string, collapsed: boolean, options: object) => void} input.setPanelCollapsed
 *   Owner callback; the strip never touches panel classes itself.
 * @param {Document} [input.documentRef]
 * @returns {{ element: HTMLElement, sync: () => void, destroy: () => void }}
 */
export function createRightRailTabs({
  rail,
  setPanelCollapsed,
  documentRef = rail.ownerDocument,
}) {
  const column = documentRef.createElement('div');
  column.id = 'right-rail-column';
  const strip = documentRef.createElement('div');
  strip.id = 'right-rail-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-orientation', 'vertical');
  strip.setAttribute('aria-label', t('Panels'));
  const tools = documentRef.createElement('div');
  tools.id = 'right-rail-tools';
  column.append(strip, tools);
  rail.setAttribute(RAIL_TABS_ATTRIBUTE, 'vertical');

  // The join: shadow under, glass, outline over; all shaped by one path.
  const svg = (tag) => documentRef.createElementNS(SVG_NS, tag);
  const join = documentRef.createElement('div');
  join.className = 'right-rail-join';
  join.setAttribute('aria-hidden', 'true');
  join.hidden = true;
  const shadow = svg('svg');
  shadow.setAttribute('class', 'right-rail-join-shadow');
  const shadowPath = svg('path');
  shadow.append(shadowPath);
  const glass = documentRef.createElement('div');
  glass.setAttribute('class', 'right-rail-join-glass');
  const outline = svg('svg');
  outline.setAttribute('class', 'right-rail-join-outline');
  const outlinePath = svg('path');
  outline.append(outlinePath);
  join.append(shadow, glass, outline);

  /** @type {Map<string, {tab: HTMLElement, icon: HTMLElement}>} */
  const entries = new Map();
  const observed = new WeakSet();
  let destroyed = false;

  const entryFor = (panel) => {
    let entry = entries.get(panel.id);
    if (entry) return entry;
    const tab = documentRef.createElement('button');
    tab.type = 'button';
    tab.className = 'right-rail-tab';
    tab.dataset.railTab = panel.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    const icon = documentRef.createElement('span');
    icon.className = 'right-rail-tab-icon material-symbols-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = RAIL_TAB_ICONS[panel.id] || 'more_horiz';
    tab.append(icon);
    entry = { tab, icon };
    entries.set(panel.id, entry);
    return entry;
  };

  const Observer =
    documentRef.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer =
    typeof Observer === 'function' ? new Observer(() => sync()) : null;
  // Panel heights follow their content and allocation: re-measure the join
  // when the strip or a panel changes size.
  const Resize = documentRef.defaultView?.ResizeObserver;
  const resizer =
    typeof Resize === 'function' ? new Resize(() => sync()) : null;
  resizer?.observe(strip);
  const observe = (panel) => {
    if (observed.has(panel)) return;
    observed.add(panel);
    resizer?.observe(panel);
    observer?.observe(panel, {
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
  };

  /** A join token from the stylesheet (--right-rail-*), in pixels. */
  const token = (computed, name, fallback) => {
    const value = parseFloat(computed?.getPropertyValue?.(name));
    return Number.isFinite(value) ? value : fallback;
  };

  /**
   * Publish the join: the open tab's bottom on the rail (--rail-tab-bottom,
   * rail pixels; the stylesheet sets the panel's minimum height from it) and
   * the joined silhouette on the join's layers. The rail can be taller than
   * its panel in the focus layout, so the join is sized from the panel,
   * extended down to cover the tab if that is shorter, but never past the
   * rail's lane (--right-stack-max-height).
   */
  function placeJoin(tab, panel) {
    if (!tab) {
      rail.style.removeProperty('--rail-tab-bottom');
      join.hidden = true;
      return;
    }
    const top = tab.offsetTop;
    rail.style.setProperty('--rail-tab-bottom', `${top + tab.offsetHeight}px`);
    const computed = documentRef.defaultView?.getComputedStyle?.(rail);
    const corner = token(computed, '--right-rail-corner', 16);
    const tabRadius = token(computed, '--right-rail-tab-radius', 10);
    const fillet = token(computed, '--right-rail-fillet', 8);
    const lane = token(computed, '--right-stack-max-height', Infinity);
    const chamfer =
      computed?.getPropertyValue?.('--right-rail-join-style').trim() ===
      'chamfer';
    // Tab offsets are relative to the strip, the strip's to the column, the
    // column's to the rail.
    const stripTop = (column.offsetTop || 0) + (strip.offsetTop || 0);
    const stripLeft = (column.offsetLeft || 0) + (strip.offsetLeft || 0);
    const tabTop = stripTop + top;
    const tabBottom = tabTop + tab.offsetHeight;
    const geometry = {
      panel: {
        x0: panel.offsetLeft,
        y0: panel.offsetTop,
        x1: panel.offsetLeft + panel.offsetWidth,
        y1: Math.max(
          panel.offsetTop + panel.offsetHeight,
          Math.min(lane, tabBottom + fillet + 4 + corner),
        ),
      },
      tab: {
        top: tabTop,
        bottom: tabBottom,
        right: stripLeft + tab.offsetLeft + tab.offsetWidth,
      },
      corner,
      tabRadius,
      fillet,
      style: chamfer ? 'chamfer' : 'round',
    };
    const shape = railJoinPath(geometry);
    const width = rail.clientWidth;
    const height = geometry.panel.y1;
    join.style.height = `${height}px`;
    glass.style.clipPath = `path('${shape}')`;
    shadowPath.setAttribute('d', shape);
    // Everything but the silhouette: the shadow it casts stays, the fill goes.
    shadow.style.clipPath = `path(evenodd, 'M -80 -80 H ${width + 80} V ${height + 80} H -80 Z ${shape}')`;
    outlinePath.setAttribute('d', railJoinPath({ ...geometry, inset: 0.5 }));
    join.hidden = false;
  }

  /** Reconcile tabs with the rail: order, visibility, selection, names. */
  function sync() {
    if (destroyed) return;
    // The column precedes its panels in the tab order, so Tab from the open
    // tab reaches the tool slot and then the open panel. The rail owner moves
    // panels in at start-up; keep the column first afterwards too.
    if (rail.firstElementChild !== column) rail.prepend(column);
    if (join.parentElement !== rail) rail.append(join);
    // Hidden panels too: Weather and Recent Imagery arrive hidden and their
    // owners reveal them by attribute, which must create their tabs.
    for (const panel of rail.children)
      if (panel.matches?.('[data-panel-id]')) observe(panel);
    const panels = [...rail.children].filter(
      (panel) => panel.matches?.('[data-panel-id]') && !panel.hidden,
    );
    const focusOwner =
      panels.find((panel) => !panel.classList.contains('collapsed')) ||
      panels[0];
    // Move a tab only when it is out of place: reinserting the focused tab
    // would drop keyboard focus on every class change.
    let cursor = strip.firstElementChild;
    let open = null;
    for (const panel of panels) {
      const { tab } = entryFor(panel);
      if (tab !== cursor) strip.insertBefore(tab, cursor);
      else cursor = cursor.nextElementSibling;
      const collapsed = panel.classList.contains('collapsed');
      if (!collapsed && !open) open = { tab, panel };
      const name = panelTitle(panel);
      tab.setAttribute('aria-label', name);
      tab.setAttribute('aria-selected', String(!collapsed));
      tab.tabIndex = panel === focusOwner ? 0 : -1;
      tab.title = t(collapsed ? msg('Expand {name}') : msg('Collapse {name}'), {
        name,
      });
    }
    const live = new Set(panels.map((panel) => panel.id));
    for (const [id, entry] of entries) {
      if (live.has(id)) continue;
      entry.tab.remove();
      entries.delete(id);
    }
    placeJoin(open?.tab, open?.panel);
  }

  const onClick = (event) => {
    const tab = event.target?.closest?.('[data-rail-tab]');
    if (!tab) return;
    const panel = documentRef.getElementById(tab.dataset.railTab);
    if (!panel) return;
    setPanelCollapsed(panel.id, !panel.classList.contains('collapsed'), {
      explicit: true,
    });
  };
  const onKeydown = (event) => {
    const current = event.target?.closest?.('[data-rail-tab]');
    if (!current) return;
    const visible = [...strip.children].filter((tab) => !tab.hidden);
    const index = visible.indexOf(current);
    const next = nextRailTabIndex(event.key, index, visible.length);
    if (next < 0 || next === index) return;
    event.preventDefault();
    visible[next].focus();
  };
  strip.addEventListener('click', onClick);
  strip.addEventListener('keydown', onKeydown);
  observer?.observe(rail, { childList: true });
  rail.prepend(column);
  rail.append(join);
  sync();

  return {
    element: strip,
    sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      resizer?.disconnect();
      strip.removeEventListener('click', onClick);
      strip.removeEventListener('keydown', onKeydown);
      column.remove();
      join.remove();
      rail.removeAttribute(RAIL_TABS_ATTRIBUTE);
      placeJoin(null, null);
      entries.clear();
    },
  };
}
