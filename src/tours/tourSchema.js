/**
 * Guided visual tour schema: beats, keyframes, query matching, script variants.
 * @module tours/tourSchema
 */

export const TOUR_SCHEMA_VERSION = 1;
export const BEAT_KINDS = Object.freeze(['establish', 'transit', 'hold']);
export const CAMERA_MODES = Object.freeze(['flyTo', 'lookAt', 'routeDolly', 'orbitHold']);
export const TRAVEL_MODES = Object.freeze(['walk', 'bike', 'drive', 'transit', 'flight']);

const CAMERA_MODE_SET = new Set(CAMERA_MODES);
const BEAT_KIND_SET = new Set(BEAT_KINDS);
const TRAVEL_MODE_SET = new Set(TRAVEL_MODES);

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function slugifyTourId(value) {
  return asString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'tour';
}

export function tourBounds(tour) {
  const pts = [];
  for (const beat of tour?.beats || []) {
    const lat = beat.place?.lat ?? beat.camera?.lat;
    const lon = beat.place?.lon ?? beat.camera?.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon });
    for (const p of beat.travel?.polyline || []) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) pts.push(p);
    }
  }
  if (!pts.length) return null;
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const p of pts) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return { west, east, south, north };
}

export function boxesOverlap(a, b, padDeg = 0) {
  if (!a || !b) return false;
  return a.west - padDeg <= b.east + padDeg
    && a.east + padDeg >= b.west - padDeg
    && a.south - padDeg <= b.north + padDeg
    && a.north + padDeg >= b.south - padDeg;
}

export function pointInBox(lat, lon, box, padDeg = 0.02) {
  if (!box || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lon >= box.west - padDeg
    && lon <= box.east + padDeg
    && lat >= box.south - padDeg
    && lat <= box.north + padDeg;
}

function normalizeCamera(raw = {}, beatKind = 'hold') {
  const inferred = beatKind === 'transit' ? 'routeDolly' : beatKind === 'establish' ? 'flyTo' : 'lookAt';
  const mode = CAMERA_MODE_SET.has(raw.mode) ? raw.mode : inferred;
  return {
    mode,
    lat: Number.isFinite(Number(raw.lat)) ? Number(raw.lat) : undefined,
    lon: Number.isFinite(Number(raw.lon)) ? Number(raw.lon) : undefined,
    alt: Number.isFinite(Number(raw.alt)) ? Number(raw.alt) : undefined,
    heading: asNumber(raw.heading, 0),
    pitch: asNumber(raw.pitch, -28),
    roll: asNumber(raw.roll, 0),
    rangeM: Number.isFinite(Number(raw.rangeM)) ? Number(raw.rangeM) : undefined,
    durationSec: Number.isFinite(Number(raw.durationSec)) ? Number(raw.durationSec) : undefined,
    approachSec: Number.isFinite(Number(raw.approachSec)) ? Number(raw.approachSec) : undefined,
    spaceAlt: Number.isFinite(Number(raw.spaceAlt)) ? Number(raw.spaceAlt) : undefined,
    compressToSec: Number.isFinite(Number(raw.compressToSec)) ? Number(raw.compressToSec) : undefined,
    buildingHeight: Number.isFinite(Number(raw.buildingHeight)) ? Number(raw.buildingHeight) : undefined,
  };
}

function normalizeTravel(raw = {}) {
  if (!raw || typeof raw !== 'object') return undefined;
  const mode = TRAVEL_MODE_SET.has(raw.mode) ? raw.mode : 'walk';
  const polyline = Array.isArray(raw.polyline)
    ? raw.polyline
      .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
      .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon), height: Number.isFinite(p.height) ? Number(p.height) : 0 }))
    : [];
  return {
    mode,
    fromPlace: asString(raw.fromPlace) || undefined,
    toPlace: asString(raw.toPlace) || undefined,
    durationRealSec: asNumber(raw.durationRealSec, 0),
    durationPlaySec: asNumber(raw.durationPlaySec, 5),
    polyline,
  };
}

export function normalizeBeat(raw = {}, index = 0) {
  const kind = BEAT_KIND_SET.has(raw.kind) ? raw.kind : 'hold';
  const variations = Array.isArray(raw.scriptVariations)
    ? raw.scriptVariations.map((line) => asString(line)).filter(Boolean)
    : [];
  const place = raw.place && typeof raw.place === 'object'
    ? {
      name: asString(raw.place.name),
      lat: asNumber(raw.place.lat),
      lon: asNumber(raw.place.lon),
    }
    : undefined;
  return {
    id: asString(raw.id, `beat-${index + 1}`),
    title: asString(raw.title, `Beat ${index + 1}`),
    kind,
    script: asString(raw.script),
    scriptVariations: variations,
    durationSec: Math.max(1, asNumber(raw.durationSec, kind === 'transit' ? 5 : 14)),
    place,
    travel: kind === 'transit' ? normalizeTravel(raw.travel) : normalizeTravel(raw.travel) || undefined,
    camera: normalizeCamera(raw.camera, kind),
  };
}

export function normalizeTour(raw = {}, { source = 'authored' } = {}) {
  const beats = Array.isArray(raw.beats) ? raw.beats.map((beat, i) => normalizeBeat(beat, i)) : [];
  const id = slugifyTourId(raw.id || raw.city || raw.title || 'tour');
  const bounds = raw.bounds && typeof raw.bounds === 'object'
    ? {
      west: asNumber(raw.bounds.west),
      east: asNumber(raw.bounds.east),
      south: asNumber(raw.bounds.south),
      north: asNumber(raw.bounds.north),
    }
    : tourBounds({ beats });
  return {
    schemaVersion: TOUR_SCHEMA_VERSION,
    id,
    title: asString(raw.title, id),
    city: asString(raw.city, raw.title || id),
    cityId: asString(raw.cityId, id),
    durationTargetSec: asNumber(raw.durationTargetSec, beats.reduce((sum, beat) => sum + beat.durationSec, 0)),
    source,
    beats,
    bounds,
  };
}

export function summarizeTour(tour) {
  if (!tour) return null;
  return {
    id: tour.id,
    title: tour.title,
    city: tour.city,
    cityId: tour.cityId,
    beatCount: tour.beats?.length || 0,
    durationTargetSec: tour.durationTargetSec,
    source: tour.source || 'authored',
    bounds: tour.bounds || null,
  };
}

export function matchTourQuery(tours, query) {
  const list = Array.isArray(tours) ? tours : [];
  const raw = asString(query).toLowerCase();
  if (!raw) return null;
  const slug = slugifyTourId(raw);
  const exact = list.find((tour) => tour.id === slug || tour.cityId === slug || String(tour.city || '').toLowerCase() === raw);
  if (exact) return exact;
  const token = (hay, needle) => {
    if (!needle) return false;
    if (needle.length < 4) return hay === needle || hay.split(/\s+/).includes(needle);
    return hay.includes(needle);
  };
  return list.find((tour) => {
    const city = String(tour.city || '').toLowerCase();
    const title = String(tour.title || '').toLowerCase();
    const id = String(tour.id || '').toLowerCase();
    return token(raw, city)
      || token(raw, id)
      || token(title, raw)
      || slugifyTourId(tour.title) === slug;
  }) || null;
}

export function pickScript(beat, used = new Set()) {
  const variants = [beat?.script, ...(beat?.scriptVariations || [])].map((line) => asString(line)).filter(Boolean);
  if (!variants.length) return '';
  const unused = variants.filter((line) => !used.has(line));
  const pick = (unused.length ? unused : variants)[0];
  used.add(pick);
  return pick;
}

export function transitConnectiveTemplates(mode) {
  const m = TRAVEL_MODE_SET.has(mode) ? mode : 'walk';
  if (m === 'transit') {
    return [
      'After a short metro hop across town, you come to',
      'A few stops on the rails and the next landmark is',
      'We take the train rather than crawl the surface streets, arriving at',
    ];
  }
  if (m === 'drive') {
    return [
      'A straight drive from here brings you to',
      'Following the fastest street route, you roll up on',
      'We stay on the road for this one and pull in at',
    ];
  }
  if (m === 'bike') {
    return [
      'A quick ride along the lanes lands you at',
      'On two wheels the next stop is close:',
    ];
  }
  if (m === 'flight') {
    return [
      'This hop is too far for streets, so we lift over the city to',
      'A short aerial jump clears the distance to',
    ];
  }
  return [
    'A few minutes on foot and you reach',
    'We stay on the pavement for this stretch, walking to',
    'No ride here — a short walk brings you to',
  ];
}
