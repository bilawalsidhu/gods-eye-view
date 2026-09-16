/**
 * Historic fire layer model — pure functions shared by the renderer, the
 * row controls and (later) the replay clock. No Cesium, no DOM.
 */
import { adaptFirmsRecords } from '../../data/firmsAdapt.js';
import { parseUtcDay, formatUtcDay } from '../../data/fireHistoryEvents.js';

export const FIRE_HISTORY_LAYER_ID = 'fire-history';
export const FIRE_HISTORY_OVERLAY_SOURCE_ID = 'fire-history';
const DAY_MS = 86_400_000;

/**
 * Progress ramp — early detections read hot yellow, the fire's late days
 * settle into ember red. Stops are [progress, r, g, b].
 */
const PROGRESS_STOPS = Object.freeze([
  [0, 255, 228, 92],
  [0.35, 255, 138, 31],
  [0.7, 232, 50, 26],
  [1, 107, 20, 20],
]);

/**
 * Where a detection falls inside the event window, 0 at the first day's
 * 00:00Z and 1 at the end of the last day. Out-of-range values clamp.
 * @param {number} acqMs - Detection acquisition epoch ms.
 * @param {{startMs?: number, endMs?: number, startDate?: string, endDate?: string}} event
 * @returns {number} 0..1, or 0 when the event range is unusable.
 */
export function eventProgress(acqMs, event) {
  const { startMs, endMs } = eventRangeMs(event);
  if (!Number.isFinite(acqMs) || !(endMs > startMs)) return 0;
  return Math.max(0, Math.min(1, (acqMs - startMs) / (endMs - startMs)));
}

/**
 * Resolve an event's ms range from either the server's public shape (dates
 * only) or the normalized shape (ms fields present).
 * @param {object} event
 * @returns {{startMs: number, endMs: number}} NaN fields when unusable.
 */
export function eventRangeMs(event) {
  const startMs = Number.isFinite(event?.startMs)
    ? event.startMs
    : parseUtcDay(event?.startDate);
  const endMs = Number.isFinite(event?.endMs)
    ? event.endMs
    : parseUtcDay(event?.endDate) + DAY_MS;
  return { startMs, endMs };
}

/**
 * Interpolate the progress ramp.
 * @param {number} progress - 0..1.
 * @returns {[number, number, number]} 0..255 RGB.
 */
export function progressRgb(progress) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  for (let i = 1; i < PROGRESS_STOPS.length; i += 1) {
    const [p1, r1, g1, b1] = PROGRESS_STOPS[i];
    if (p > p1) continue;
    const [p0, r0, g0, b0] = PROGRESS_STOPS[i - 1];
    const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
    return [
      Math.round(r0 + (r1 - r0) * t),
      Math.round(g0 + (g1 - g0) * t),
      Math.round(b0 + (b1 - b0) * t),
    ];
  }
  const [, r, g, b] = PROGRESS_STOPS[PROGRESS_STOPS.length - 1];
  return [r, g, b];
}

/**
 * CSS color for a progress value (legend swatches, cards).
 * @param {number} progress - 0..1.
 * @returns {string} `rgb(r, g, b)`.
 */
export function progressCss(progress) {
  const [r, g, b] = progressRgb(progress);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Screen size for one detection point. VIIRS pixels are 375 m, MODIS 1 km,
 * so MODIS reads slightly larger; fire radiative power adds up to +5 px.
 * @param {number|null} frp - Fire radiative power (MW).
 * @param {string} sensor - 'VIIRS' | 'MODIS' | other.
 * @returns {number} Pixel size.
 */
export function detectionPixelSize(frp, sensor) {
  const base = sensor === 'MODIS' ? 6 : 4;
  const power = Number.isFinite(frp) && frp > 0 ? Math.log10(1 + frp) : 0;
  return Math.round(base + Math.min(5, power * 2));
}

/**
 * Adapt proxy records and stamp each with its event progress. Detections
 * without a parseable acquisition time (the adapter reports those as 0) are
 * dropped: without a time they cannot be placed in the replay.
 * @param {Array<object>} records - `/api/fire-history/<id>` fires.
 * @param {object} event - Event carrying the date range.
 * @returns {Array<object>} Fire records sorted by acquisition time.
 */
export function adaptFireHistoryRecords(records, event) {
  const fires = adaptFirmsRecords(records)
    .filter((fire) => Number.isFinite(fire.acqMs) && fire.acqMs > 0)
    .sort((a, b) => a.acqMs - b.acqMs);
  return fires.map((fire, index) => ({
    ...fire,
    index,
    progress: eventProgress(fire.acqMs, event),
  }));
}

/**
 * Per-UTC-day detection counts across the whole event range, including
 * quiet days, so a timeline chart has a continuous axis.
 * @param {Array<{acqMs: number, frp: number|null}>} fires
 * @param {object} event
 * @returns {Array<{date: string, count: number, maxFrp: number}>}
 */
export function buildEventTimeline(fires, event) {
  const { startMs, endMs } = eventRangeMs(event);
  if (!(endMs > startMs)) return [];
  const days = Math.round((endMs - startMs) / DAY_MS);
  const timeline = Array.from({ length: days }, (_, i) => ({
    date: formatUtcDay(startMs + i * DAY_MS),
    count: 0,
    maxFrp: 0,
  }));
  for (const fire of fires || []) {
    const i = Math.floor((fire.acqMs - startMs) / DAY_MS);
    if (i < 0 || i >= days) continue;
    timeline[i].count += 1;
    if (Number.isFinite(fire.frp) && fire.frp > timeline[i].maxFrp)
      timeline[i].maxFrp = fire.frp;
  }
  return timeline;
}

/**
 * Choose the event to display: the requested id when it exists, else the
 * first registered event, else null.
 * @param {Array<{id: string}>} events
 * @param {?string} requestedId
 * @returns {?object}
 */
export function selectEvent(events, requestedId) {
  if (!Array.isArray(events) || !events.length) return null;
  return events.find((event) => event.id === requestedId) || events[0];
}

/**
 * Center of an event box, for the ambient label and the camera target.
 * @param {number[]} bbox - [west, south, east, north].
 * @returns {{lon: number, lat: number}}
 */
export function eventCenter(bbox) {
  const [west, south, east, north] = bbox;
  return { lon: (west + east) / 2, lat: (south + north) / 2 };
}

/**
 * Row controls for the Data Layers panel: one chip per registered event and
 * a three-band legend of the progress ramp with detection counts.
 * @param {object} input
 * @param {Array<object>} input.events - Registered events.
 * @param {?string} input.selectedId - Currently shown event.
 * @param {boolean} input.loading - A load is in flight.
 * @param {Array<{progress: number}>} input.fires - Rendered detections.
 * @returns {{chips: Array<object>, legend: Array<object>}}
 */
export function fireHistoryRowControls({ events, selectedId, loading, fires }) {
  const chips = (events || []).map((event) => ({
    id: event.id,
    label: `${event.name} · ${String(event.startDate).slice(0, 4)}`,
    title: event.region
      ? `${event.region} · ${event.startDate} → ${event.endDate}`
      : `${event.startDate} → ${event.endDate}`,
    active: event.id === selectedId,
    busy: Boolean(loading) && event.id === selectedId,
    // Settles through the manager as a layer param, so share links carry it.
    params: { eventId: event.id },
  }));
  const bands = [
    { label: 'Early', from: 0, to: 1 / 3, swatch: 0.1 },
    { label: 'Mid', from: 1 / 3, to: 2 / 3, swatch: 0.5 },
    { label: 'Late', from: 2 / 3, to: 1.01, swatch: 0.9 },
  ];
  const legend = fires?.length
    ? bands.map((band) => ({
        label: band.label,
        color: progressCss(band.swatch),
        count: fires.filter(
          (fire) => fire.progress >= band.from && fire.progress < band.to,
        ).length,
        blurb: `Detections in the ${band.label.toLowerCase()} third of the event window`,
      }))
    : [];
  return { chips, legend };
}

/**
 * JSON-safe analyst record for one detection (analyst query engine seam).
 * @param {object} fire - Adapted fire record.
 * @param {object} event - Event the detection belongs to.
 * @returns {object}
 */
export function mapAnalystRecord(fire, event) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: `${event?.id || 'fire'}-${String(fire?.index ?? 0).padStart(5, '0')}`,
    eventId: event?.id || null,
    eventName: event?.name || null,
    lat: num(fire?.lat),
    lon: num(fire?.lon),
    timeMs: num(fire?.acqMs),
    progress: num(fire?.progress),
    frpMw: num(fire?.frp),
    confidence: num(fire?.confidence),
    sensor: fire?.sensor || null,
    satellite: fire?.satellite || null,
  };
}

/**
 * Ambient world-overlay label anchored at the event center.
 * @param {object} input
 * @param {object} input.event
 * @param {*} input.position - Cesium.Cartesian3 (opaque here).
 * @param {number} input.count
 * @returns {object}
 */
export function createFireHistoryOverlayEntry({ event, position, count }) {
  return {
    id: `fire-history:${event.id}`,
    position,
    variant: 'label',
    title: `${event.name.toUpperCase()} · ${String(event.startDate).slice(0, 4)}`,
    subtitle: `${count.toLocaleString('en-US')} archived detections`,
    accent: progressCss(0.55),
    priority: 1_000_000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 18,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Compact count for the row readout during replay ("1.2K / 5.5K").
 * @param {number} value
 * @returns {string}
 */
export function compactCount(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Flatten a GeoJSON Polygon/MultiPolygon into closed rings of [lon, lat],
 * dropping rings that cannot form an outline.
 * @param {?{type: string, coordinates: Array}} geometry
 * @returns {Array<Array<[number, number]>>}
 */
export function perimeterRings(geometry) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const rings = [];
  for (const polygon of polygons || []) {
    for (const ring of polygon || []) {
      const points = (ring || [])
        .filter(
          (pt) =>
            Array.isArray(pt) &&
            Number.isFinite(pt[0]) &&
            Number.isFinite(pt[1]) &&
            Math.abs(pt[0]) <= 180 &&
            Math.abs(pt[1]) <= 90,
        )
        .map(([lon, lat]) => [lon, lat]);
      const [fx, fy] = points[0] || [];
      const [lx, ly] = points[points.length - 1] || [];
      const closed = points.length > 1 && fx === lx && fy === ly;
      // Three distinct vertices minimum; a closed ring repeats its first.
      if (points.length < (closed ? 4 : 3)) continue;
      if (!closed) points.push([fx, fy]);
      rings.push(points);
    }
  }
  return rings;
}

/**
 * Panel/legend copy for a loaded perimeter.
 * @param {?{hectares: number|null, label: string, dateCurrentMs: number|null}} perimeter
 * @returns {string}
 */
export function perimeterText(perimeter) {
  if (!perimeter) return 'NO OFFICIAL PERIMETER REGISTERED';
  const area =
    Number.isFinite(perimeter.hectares) && perimeter.hectares > 0
      ? `${Math.round(perimeter.hectares).toLocaleString('en-US')} HA`
      : 'AREA UNAVAILABLE';
  const dated = Number.isFinite(perimeter.dateCurrentMs)
    ? ` · AS OF ${new Date(perimeter.dateCurrentMs).toISOString().slice(0, 10)}`
    : '';
  return `${area} · ${perimeter.label || 'NIFC'}${dated}`;
}
