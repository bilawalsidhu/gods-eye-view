/** Card model for one selected fire-perimeter incident. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';

export const PERIMETER_OVERLAY_SOURCE_ID = 'fire-perimeters';

/** CSS accent for a perimeter card by containment progress (mirrors the fill). */
export function containmentAccent(containedPct) {
  if (!Number.isFinite(containedPct) || containedPct <= 0) return '#ff3b30';
  if (containedPct < 50) return '#ff7a00';
  if (containedPct < 100) return '#ffb300';
  return '#8bc34a';
}

/** Shoelace area (degree², sign dropped) — relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * Anchor point for the incident card: the centroid of the largest polygon's
 * outer ring. Degrees, so callers own the Cartesian conversion.
 * @param {Array<Array<Array<[number, number]>>>} polygons - Normalized rows' polygons.
 * @returns {{lon: number, lat: number}}
 */
export function perimeterAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const outer = rings[0];
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  // Vertex mean over the closed ring (first == last point dropped): perimeters
  // are compact enough that this stays inside or near the polygon.
  let lon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

/** Compact USD, e.g. $85K / $4.2M / $1.3B. Null under $1,000. */
function formatCost(dollars) {
  if (!Number.isFinite(dollars) || dollars < 1000) return null;
  const units = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ];
  let index = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    if (dollars >= units[i][0]) {
      index = i;
      break;
    }
  }
  // 999,500 must promote to $1M, never render as $1000K.
  if (dollars >= units[index][0] * 999.5 && index < units.length - 1) index++;
  const value = dollars / units[index][0];
  return `$${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${units[index][1]}`;
}

/** WFIGS complex names arrive ALL-CAPS; render them in title case. */
function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('hazard.perimeters.age.minutes', {
      m: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  if (hours < 24) return t('hazard.perimeters.age.hours', { h: hours });
  return t('hazard.perimeters.age.days', { n: Math.floor(hours / 24) });
}

/**
 * Build the overlay-host entry for one selected incident. The caller supplies
 * `position` (Cartesian) separately — this model stays JSON-safe for tests.
 * @param {Object} row - Normalized perimeter row (see records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @param {{link: ?string}} [extras] - Optional InciWeb page for this incident.
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildIncidentCard(row, nowMs, { link = null } = {}) {
  const facts = [];
  if (Number.isFinite(row.acres))
    facts.push(
      t('hazard.perimeters.card.acres', {
        acres: formatNumber(Math.round(row.acres)),
      }),
    );
  facts.push(
    Number.isFinite(row.containedPct)
      ? t('hazard.perimeters.card.contained', {
          pct: Math.round(row.containedPct),
        })
      : t('hazard.perimeters.card.containmentUnknown'),
  );
  if (row.state) facts.push(row.state);
  else if (row.category) facts.push(row.category);

  const situation = [];
  if (row.cause)
    situation.push(t('hazard.perimeters.card.cause', { cause: row.cause }));
  if (row.behavior) situation.push(row.behavior);
  if (row.complexity) situation.push(row.complexity);

  const response = [];
  if (Number.isFinite(row.personnel))
    response.push(
      t('hazard.perimeters.card.personnel', {
        n: formatNumber(Math.round(row.personnel)),
      }),
    );
  if (row.county)
    response.push(t('hazard.perimeters.card.county', { county: row.county }));
  if (Number.isFinite(row.costToDate)) {
    const cost = formatCost(row.costToDate);
    if (cost) response.push(t('hazard.perimeters.card.costToDate', { cost }));
  }

  const ages = [];
  const discovered = formatAge(nowMs - row.discoveredTime);
  if (row.discoveredTime != null && discovered)
    ages.push(t('hazard.perimeters.card.discovered', { age: discovered }));
  const updated = formatAge(nowMs - row.updatedTime);
  if (row.updatedTime != null && updated)
    ages.push(t('hazard.perimeters.card.updated', { age: updated }));

  const details = [facts.join(' · ')];
  if (row.complexName)
    details.push(
      t('hazard.perimeters.card.partOf', {
        name: titleCase(row.complexName),
      }),
    );
  if (situation.length) details.push(situation.join(' · '));
  if (response.length) details.push(response.join(' · '));
  if (ages.length) details.push(ages.join(' · '));
  if (link) details.push(t('hazard.perimeters.card.inciweb'));

  const title = t('hazard.perimeters.card.title', {
    name: row.name || t('hazard.perimeters.card.unnamed'),
  });
  return {
    id: `fire-perimeter-card:${row.stableId}`,
    // `selected` picks the paint lane and collision protection; an explicit
    // paintLane would override it in the host's lane resolver.
    selected: true,
    // Only a linked card is clickable — the overlay host registers hit
    // rectangles solely for interactive entries.
    interactive: Boolean(link),
    ...(link
      ? {
          accessibilityLabel: t('hazard.perimeters.card.openAria', {
            title,
          }),
        }
      : undefined),
    title,
    details,
    accent: containmentAccent(row.containedPct),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
