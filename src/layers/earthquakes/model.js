export const EARTHQUAKE_OVERLAY_SOURCE_ID = 'earthquakes';
export const EARTHQUAKE_OVERLAY_COHORT_LIMIT = 96;
export const EARTHQUAKE_OVERLAY_COLLISION_CAPACITY = 48;

// The depth bands' colours: CSS red, orange and yellow, as the renderer's
// colour tuples (`[r, g, b, a]`, 0..1) and as CSS for the labels' accent.
const SHALLOW = Object.freeze({ rgba: [1, 0, 0, 1], css: 'rgb(255,0,0)' });
const INTERMEDIATE = Object.freeze({
  rgba: [1, 165 / 255, 0, 1],
  css: 'rgb(255,165,0)',
});
const DEEP = Object.freeze({ rgba: [1, 1, 0, 1], css: 'rgb(255,255,0)' });

const depthBand = (depthKm) =>
  depthKm < 70 ? SHALLOW : depthKm < 300 ? INTERMEDIATE : DEEP;

/**
 * The smallest magnitude the timeline marks. Most quakes are small shakes;
 * M6 and up come about once every two days worldwide, so each is an event
 * worth stepping to. The map still draws every quake.
 */
export const EARTHQUAKE_MARK_MAGNITUDE = 6;

/** The longest place a timeline mark's label carries, ellipsis and all. */
const MARK_PLACE_LENGTH = 40;
/**
 * The longest place line the detail card shows, ellipsis and all, so a long
 * place or translation keeps the card inside a phone's width. The card's
 * accessible name carries the whole place.
 */
const CARD_PLACE_LENGTH = 48;

/** A magnitude as the map's labels show it: `M6.4`. */
export const earthquakeMagnitudeTitle = (magnitude) =>
  `M${Number(magnitude).toFixed(1)}`;

/**
 * A strong quake's timeline label: its magnitude and, where the feed names
 * one, its place, cut short (`M6.4 · 113 km SSE of Lata, Solomon Islands`).
 * @param {{mag: number, place?: string | null}} event
 * @returns {string}
 */
export function earthquakeMarkLabel({ mag, place }) {
  const title = earthquakeMagnitudeTitle(mag);
  const where =
    typeof place === 'string' ? place.replace(/\s+/g, ' ').trim() : '';
  if (!where) return title;
  const short =
    where.length > MARK_PLACE_LENGTH
      ? `${where.slice(0, MARK_PLACE_LENGTH - 1).trimEnd()}…`
      : where;
  return `${title} · ${short}`;
}

/**
 * The time a world clock's timeline can show for `events` (`{mag, time,
 * place?, usgsId?}`, time in ms): the span of the quakes of
 * EARTHQUAKE_MARK_MAGNITUDE and up, each one a mark labelled with its
 * magnitude and place, or null with none, so the layer never stretches the
 * timeline past what its feed covers.
 * @returns {{start: number, end: number, marks: Array<{time: number, label: string, id?: string, kind: string}>} | null}
 */
export function earthquakeCoverage(events) {
  const marks = events
    .filter(
      ({ mag, time }) =>
        mag >= EARTHQUAKE_MARK_MAGNITUDE && Number.isFinite(time),
    )
    .map((event) => ({
      time: event.time,
      label: earthquakeMarkLabel(event),
      ...(event.usgsId ? { id: String(event.usgsId) } : {}),
      kind: 'earthquake',
    }))
    .sort((a, b) => a.time - b.time);
  return marks.length
    ? { start: marks[0].time, end: marks.at(-1).time, marks }
    : null;
}

/**
 * Color by depth, as a renderer colour `[r, g, b, a]` (0..1):
 *  - Shallow (<70km): Red
 *  - Intermediate (70-300km): Orange
 *  - Deep (>300km): Yellow
 */
export function depthColor(depthKm) {
  return [...depthBand(depthKm).rgba];
}

/** The depth band's colour as CSS, for the magnitude label's accent. */
export const depthAccent = (depthKm) => depthBand(depthKm).css;

/**
 * Build the source-owned presentation for one ambient magnitude label.
 * Magnitude formatting deliberately remains here instead of moving into the
 * shared renderer.
 * @param {object} input
 * @param {string} input.id Stable USGS or deterministic fallback id.
 * @param {{x: number, y: number, z: number}} input.position ECEF ground
 *   anchor, shared with the disc.
 * @param {number} input.magnitude USGS magnitude.
 * @param {string} input.accent Source-owned depth-band color.
 * @returns {object}
 */
export function createEarthquakeOverlayEntry({
  id,
  position,
  magnitude,
  accent,
}) {
  const mag = Number(magnitude);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: earthquakeMagnitudeTitle(mag),
    accent,
    priority: Math.round(mag * 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Where USGS publishes one event's page, its event id appended. */
export const USGS_EVENT_PAGE_URL =
  'https://earthquake.usgs.gov/earthquakes/eventpage/';

/**
 * The USGS page for an event id, or null when there is no usable id (a
 * fallback `event-N` id never names a USGS page, and is never sent).
 * @param {unknown} usgsId
 * @returns {string|null}
 */
export function earthquakeEventLink(usgsId) {
  const id =
    typeof usgsId === 'string' || typeof usgsId === 'number'
      ? String(usgsId).trim()
      : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
    ? `${USGS_EVENT_PAGE_URL}${id}`
    : null;
}

// The package carries no i18n: with no translator given, the card stays
// English, its `{name}` slots filled in.
const english = (text, values) =>
  String(text).replace(/\{(\w+)\}/g, (all, key) =>
    values && Object.hasOwn(values, key) ? String(values[key]) : all,
  );
const utcMinute = (time) =>
  `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const oneDecimal = (value) => String(Math.round(value * 10) / 10);

/**
 * The detail card one clicked earthquake shows: its magnitude as the title,
 * then where, when and how deep, and the source. With a USGS event id the
 * card opens that event's page.
 * @param {{mag: number, place?: string|null, time?: number|null,
 *   depthKm?: number|null, usgsId?: string|null}} event
 * @param {object} [text] The application's formatters.
 * @param {(text: string, values?: object) => string} [text.t] Translator.
 * @param {(time: number) => string} [text.formatTime] An event time.
 * @param {(value: number) => string} [text.formatDepth] A depth in km.
 * @param {boolean} [text.canOpen] Whether a link can be opened here (an
 *   opener is injected); without one the card offers no link to click.
 * @returns {{title: string, details: string[], link: string|null,
 *   accessibilityLabel: string}} `accessibilityLabel` names the card's
 *   action, with its details: opening the source, or focusing the quake.
 */
export function describeEarthquake(
  event,
  {
    t = english,
    formatTime = utcMinute,
    formatDepth = oneDecimal,
    canOpen = true,
  } = {},
) {
  const details = [];
  // What the card says, spoken: depth, the whole place, and the time.
  const spoken = [];
  // Severity at a glance, right under the title: the class meter, then
  // where in the crust it broke.
  const glance = [earthquakeSeverityMeter(event?.mag)];
  if (Number.isFinite(event?.depthKm)) {
    const depth = `${earthquakeDepthBandName(event.depthKm, t)} · ${t(
      '{km} km deep',
      { km: formatDepth(event.depthKm) },
    )}`;
    glance.push(depth);
    spoken.push(depth);
  }
  details.push(glance.join('  '));
  const place =
    typeof event?.place === 'string'
      ? event.place.replace(/\s+/g, ' ').trim()
      : '';
  if (place) {
    // Cut by characters, not UTF-16 units, so a pair is never split.
    const chars = Array.from(place);
    details.push(
      chars.length > CARD_PLACE_LENGTH
        ? `${chars
            .slice(0, CARD_PLACE_LENGTH - 1)
            .join('')
            .trimEnd()}…`
        : place,
    );
    spoken.push(place);
  }
  if (Number.isFinite(event?.time)) {
    const time = formatTime(event.time);
    details.push(time);
    spoken.push(time);
  }
  const source = t('Source: {value}', { value: 'USGS' });
  details.push(source);
  // The source closes the spoken details, so they are never empty.
  spoken.push(source);
  const link = earthquakeEventLink(event?.usgsId);
  const opens = Boolean(link) && canOpen;
  if (opens) details.push(t('Click the card to open the source ↗'));
  const title = `${earthquakeMagnitudeTitle(event?.mag)} · ${earthquakeSeverityName(
    event?.mag,
    t,
  )}`;
  const summary = { title, details: spoken.join(', ') };
  return {
    title,
    details,
    link,
    accessibilityLabel: opens
      ? t('Open the source for {title}, {details}', summary)
      : t('Focus earthquake {title}, {details}', summary),
  };
}

/**
 * USGS's magnitude classes, weakest first: minor (under 4; the feed starts
 * at M2.5), light, moderate, strong, major, great (8 and up).
 */
export const EARTHQUAKE_SEVERITY_LEVELS = 6;

/**
 * A magnitude's USGS class, 0 (minor) to 5 (great).
 * @param {number} magnitude
 * @returns {number}
 */
export function earthquakeSeverityLevel(magnitude) {
  const mag = Number(magnitude);
  if (!Number.isFinite(mag) || mag < 4) return 0;
  return Math.min(EARTHQUAKE_SEVERITY_LEVELS - 1, Math.floor(mag) - 3);
}

/** A magnitude's class, as a word in the page's language. */
export function earthquakeSeverityName(magnitude, t = english) {
  switch (earthquakeSeverityLevel(magnitude)) {
    case 5:
      return t('Great', { context: 'earthquake' });
    case 4:
      return t('Major', { context: 'earthquake' });
    case 3:
      return t('Strong', { context: 'earthquake' });
    case 2:
      return t('Moderate', { context: 'earthquake' });
    case 1:
      return t('Light', { context: 'earthquake' });
    default:
      return t('Minor', { context: 'earthquake' });
  }
}

/**
 * The class as a six-step meter, one filled block per class up to this one:
 * `■■□□□□` for a light quake. Plain text, so the card shows it as it is.
 * @param {number} magnitude
 * @returns {string}
 */
export function earthquakeSeverityMeter(magnitude) {
  const filled = earthquakeSeverityLevel(magnitude) + 1;
  return '■'.repeat(filled) + '□'.repeat(EARTHQUAKE_SEVERITY_LEVELS - filled);
}

/**
 * The depth band the disc's colour shows, as a word: shallow (under 70 km,
 * red), intermediate (to 300 km, orange), deep (yellow).
 */
export function earthquakeDepthBandName(depthKm, t = english) {
  const band = depthBand(depthKm);
  if (band === SHALLOW) return t('Shallow', { context: 'earthquake' });
  if (band === INTERMEDIATE)
    return t('Intermediate', { context: 'earthquake' });
  return t('Deep', { context: 'earthquake' });
}

/**
 * A quake's disc radius on the ground, in metres: it doubles with each
 * magnitude step (about 5.7 km at M2.5, 32 km at M5, 64 km at M6).
 * @param {number} magnitude
 * @returns {number}
 */
export const earthquakeDiscRadiusM = (magnitude) =>
  Math.pow(2, magnitude) * 1000;

/** How many contour lines run out from a selected quake at once. */
export const EARTHQUAKE_RIPPLE_RINGS = 6;
/** How long one contour line takes from the marker to the disc's edge. */
export const EARTHQUAKE_RIPPLE_PERIOD_MS = 4800;
/** Every this many lines one is an index contour, drawn heavier. */
export const EARTHQUAKE_INDEX_CONTOUR_EVERY = 3;

/**
 * How far a contour line dents in from the circle, as a share of its
 * radius. Kept with the drift below so nested lines never cross: a line's
 * radius grows with `fraction` faster than its dents move (see
 * earthquakeContourScale).
 */
export const EARTHQUAKE_CONTOUR_WOBBLE = 0.24;
const CONTOUR_HARMONICS = Object.freeze([2, 3, 5]);
const CONTOUR_WEIGHTS = Object.freeze([1, 0.6, 0.3]);
const CONTOUR_MAX_DRIFT = 1.5;

/** A stable 32-bit hash of a string (FNV-1a). */
function hashString(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * One quake's contour shape: a few harmonics around the circle, each with
 * its own phase and a drift that turns it as a line runs outward, seeded by
 * the quake's id so the same quake always draws the same contours.
 * @param {string} seed The quake's stable id.
 * @returns {ReadonlyArray<{harmonic: number, weight: number, phase: number, drift: number}>}
 */
export function earthquakeContourShape(seed) {
  let state = hashString(seed) || 1;
  // xorshift32: a small, stable stream from the seed.
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  return Object.freeze(
    CONTOUR_HARMONICS.map((harmonic, i) =>
      Object.freeze({
        harmonic,
        weight: CONTOUR_WEIGHTS[i],
        phase: next() * 2 * Math.PI,
        drift: (next() * 2 - 1) * CONTOUR_MAX_DRIFT,
      }),
    ),
  );
}

/**
 * Where a contour line runs at `angle` (radians), as a share of a circle of
 * the same `fraction`: between 1 - EARTHQUAKE_CONTOUR_WOBBLE and 1, so the
 * outermost line never leaves the disc. The dents turn as `fraction` grows,
 * and no faster than the line grows, so lines never cross: with wobble A
 * and drift D, d(fraction · scale)/d(fraction) ≥ 1 - A - A·D/2 > 0.
 * @param {ReturnType<typeof earthquakeContourShape>} shape
 * @param {number} angle
 * @param {number} fraction 0 at the marker, 1 at the disc's edge.
 * @returns {number}
 */
export function earthquakeContourScale(shape, angle, fraction) {
  let sum = 0;
  let total = 0;
  for (const { harmonic, weight, phase, drift } of shape) {
    sum += weight * Math.sin(harmonic * angle + phase + drift * fraction);
    total += weight;
  }
  const n = total > 0 ? sum / total : 0;
  return 1 - (EARTHQUAKE_CONTOUR_WOBBLE * (1 - n)) / 2;
}

/**
 * The selected quake's contour lines at a time: each runs from the marker
 * (`fraction` 0) out to the disc's edge (1), evenly staggered, fading in
 * just after it starts and out as it reaches the edge; every
 * EARTHQUAKE_INDEX_CONTOUR_EVERY-th is an index contour. Pure: the painter
 * gives the clock.
 * @param {number} timeMs Any steady clock, in milliseconds.
 * @param {{count?: number, periodMs?: number}} [options]
 * @returns {Array<{fraction: number, alpha: number, index: boolean}>}
 */
export function earthquakeRippleRings(
  timeMs,
  {
    count = EARTHQUAKE_RIPPLE_RINGS,
    periodMs = EARTHQUAKE_RIPPLE_PERIOD_MS,
  } = {},
) {
  const phase = Number.isFinite(timeMs) && periodMs > 0 ? timeMs / periodMs : 0;
  const rings = [];
  for (let k = 0; k < count; k++) {
    const fraction = (((phase + k / count) % 1) + 1) % 1;
    rings.push({
      fraction,
      alpha: earthquakeRippleAlpha(fraction),
      index: k % EARTHQUAKE_INDEX_CONTOUR_EVERY === 0,
    });
  }
  return rings;
}

/**
 * Still contour lines, for viewers who ask for reduced motion: the same
 * lines as the animation, held evenly spaced out to the edge.
 * @param {number} [count]
 * @returns {Array<{fraction: number, alpha: number, index: boolean}>}
 */
export function earthquakeContourRings(count = EARTHQUAKE_RIPPLE_RINGS) {
  const rings = [];
  for (let k = 1; k <= count; k++)
    rings.push({
      fraction: k / count,
      alpha: 0.7,
      index: k % EARTHQUAKE_INDEX_CONTOUR_EVERY === 0,
    });
  return rings;
}

const RIPPLE_FADE_IN = 0.12;
/** A ring's opacity where it is: in from 0 near the marker, out to 0 at the edge. */
function earthquakeRippleAlpha(fraction) {
  if (fraction <= 0 || fraction >= 1) return 0;
  return fraction < RIPPLE_FADE_IN
    ? fraction / RIPPLE_FADE_IN
    : (1 - fraction) / (1 - RIPPLE_FADE_IN);
}

/**
 * What a magnitude label says to assistive technology: activating it zooms
 * to the quake (`Zoom to M5.0 · 42 km SW of Anchorage, Alaska`).
 * @param {{mag: number, place?: string|null}} event
 * @param {{t?: (text: string, values?: object) => string}} [text]
 * @returns {string}
 */
export function earthquakeZoomLabel(event, { t = english } = {}) {
  return t('Zoom to {name}', { name: earthquakeMarkLabel(event) });
}

/** Keep the largest events, with stable identity as the tie-break. */
export function selectEarthquakeOverlayCohort(
  entries,
  limit = EARTHQUAKE_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(EARTHQUAKE_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one earthquake's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. Falls back to an index-based id
 * when the USGS event id is absent.
 * @param {Object|null|undefined} raw - Plain values pulled off the entity:
 *   {id, mag, place, time, depth, lat, lon}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, magnitude: number|null, depthKm: number|null,
 *   lat: number|null, lon: number|null, timeMs: number|null, place: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `QUAKE-${String(index).padStart(4, '0')}`,
    magnitude: num(raw?.mag),
    depthKm: num(raw?.depth),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.time), // USGS epoch ms
    place: text(raw?.place),
  };
}

export { normalizeEarthquakeSnapshot } from './records.js';
