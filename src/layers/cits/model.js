/**
 * Presentation policy for C-ITS stations relayed by OpenTrafficMap.
 *
 * Styled after Street Traffic: small grounded dots in the traffic flow
 * palette (free green / slow amber / jam red, white when unknown), the same
 * distance scaling and fade, glowing ground corridors for hazards, and the
 * same preset-aware treatment under NVG/FLIR/CRT.
 */

export const CITS_PICK_PREFIX = 'cits:';

/** Bandwidth modes: tiled `/ws_tiled` or the full `/ws_ext` stream. */
export const CITS_BANDWIDTH_MODES = Object.freeze(['tiled', 'full']);

/** Tiled mode stops asking for data above this camera altitude. */
export const CITS_MAX_VIEW_ALTITUDE_M = 60_000;
/** Query radius bounds around the view centre. */
export const CITS_MIN_RADIUS_M = 800;
export const CITS_MAX_RADIUS_M = 12_000;
/** Intersection lanes are only loaded below this altitude. */
export const CITS_LANE_MAX_ALTITUDE_M = 15_000;
/** Hazard corridors are only drawn below this altitude. */
export const CITS_HAZARD_PATH_MAX_ALTITUDE_M = 400_000;
/** World-overlay labels are only published below this altitude. */
export const CITS_LABEL_MAX_ALTITUDE_M = 6_000;
/** Dots sit this far above the sampled surface (Street Traffic's offset). */
export const CITS_DOT_HEIGHT_OFFSET_M = 3;

/** Street Traffic flow palette (`FLOW_BUCKET_COLORS`), as CSS. */
export const CITS_BUCKET_CSS = Object.freeze({
  free: '#2ecc71',
  slow: '#f0b23e',
  jam: '#e05252',
});
export const CITS_UNKNOWN_CSS = '#ffffff';

// Larger than Street Traffic's road-class dots (4-6 px): these sit on
// signal-coloured lanes in the same palette and must read on top of them.
const VEHICLE_KINDS = Object.freeze({
  car: { label: 'Car', size: 7 },
  bus: { label: 'Bus', size: 9 },
  tram: { label: 'Tram', size: 9 },
  heavy_truck: { label: 'Heavy truck', size: 8 },
  light_truck: { label: 'Light truck', size: 8 },
  special_vehicle: { label: 'Special vehicle', size: 8 },
  motorcycle: { label: 'Motorcycle', size: 6 },
  cyclist: { label: 'Cyclist', size: 6 },
  pedestrian: { label: 'Pedestrian', size: 6 },
});
const FIXED_KINDS = Object.freeze({
  traffic_light: { label: 'Traffic light', size: 5 },
  rsu: { label: 'Roadside unit', size: 3 },
  trailer: { label: 'Warning trailer', size: 5 },
});

/** Human label for a station kind. */
export function citsKindLabel(kind) {
  return (
    VEHICLE_KINDS[kind]?.label ||
    FIXED_KINDS[kind]?.label ||
    (kind === 'hazard' ? 'Hazard (DENM)' : 'Unknown station')
  );
}

/** True for stations that move (and are interpolated between reports). */
export function citsIsVehicle(kind) {
  return Object.hasOwn(VEHICLE_KINDS, kind) || kind === 'unknown';
}

/** Flow bucket from a reported speed, mirroring the traffic palette. */
export function citsSpeedBucket(speedKmh) {
  if (speedKmh == null || !Number.isFinite(speedKmh)) return null;
  if (speedKmh < 5) return 'jam';
  if (speedKmh < 30) return 'slow';
  return 'free';
}

/** SPaT `eventState` (ETSI MovementPhaseState) to a label and bucket. */
export function citsSignalState(state) {
  switch (state) {
    case 2:
      return { label: 'Stop then proceed', bucket: 'slow' };
    case 3:
      return { label: 'Red', bucket: 'jam' };
    case 4:
      return { label: 'Red-amber', bucket: 'slow' };
    case 5:
      return { label: 'Green (permissive)', bucket: 'free' };
    case 6:
      return { label: 'Green (protected)', bucket: 'free' };
    case 7:
      return { label: 'Amber (permissive)', bucket: 'slow' };
    case 8:
      return { label: 'Amber (protected)', bucket: 'slow' };
    case 9:
      return { label: 'Amber flashing', bucket: 'slow' };
    default:
      return null;
  }
}

/** One bucket summarising an intersection: any green wins, then amber. */
function signalBucket(spat) {
  if (!Array.isArray(spat) || !spat.length) return null;
  const buckets = new Set(
    spat.map((group) => citsSignalState(group.state)?.bucket).filter(Boolean),
  );
  if (buckets.has('free')) return 'free';
  if (buckets.has('slow')) return 'slow';
  if (buckets.has('jam')) return 'jam';
  return null;
}

/**
 * Dot treatment for one station.
 * @returns {{bucket:'free'|'slow'|'jam'|null, css:string, alpha:number, size:number}}
 */
export function citsDotStyle(object) {
  const stale = object.stale === true;
  let bucket = null;
  let size;
  let alpha = 0.9;
  if (object.kind === 'hazard') {
    bucket = object.hazardKind === 'roadworks' ? 'slow' : 'jam';
    size = 7;
  } else if (object.kind === 'traffic_light') {
    bucket = signalBucket(object.spat);
    size = FIXED_KINDS.traffic_light.size;
    if (!bucket) alpha = 0.6;
  } else if (object.kind === 'trailer') {
    bucket = 'slow';
    size = FIXED_KINDS.trailer.size;
  } else if (object.kind === 'rsu') {
    size = FIXED_KINDS.rsu.size;
    alpha = 0.45;
  } else {
    bucket = citsSpeedBucket(object.speedKmh);
    size = VEHICLE_KINDS[object.kind]?.size || 6;
    if (!bucket) alpha = 0.85;
  }
  if (stale) alpha *= 0.35;
  return {
    bucket,
    css: bucket ? CITS_BUCKET_CSS[bucket] : CITS_UNKNOWN_CSS,
    alpha,
    size,
  };
}

/** Lane colour for one MAPEM lane given its intersection's SPaT groups. */
export function citsLaneStyle(lane, groupStates) {
  if (lane.ingress && groupStates) {
    for (const group of lane.signalGroups) {
      const info = citsSignalState(groupStates.get(group));
      if (info) return { css: CITS_BUCKET_CSS[info.bucket], alpha: 0.85 };
    }
  }
  return { css: CITS_UNKNOWN_CSS, alpha: lane.ingress ? 0.35 : 0.18 };
}

/** Corridor bucket for a DENM hazard: roadworks read slow, others jam. */
export function citsHazardBucket(kind) {
  return kind === 'roadworks' ? 'slow' : 'jam';
}

/** A query box of `radiusM` around a centre in degrees. */
export function citsBoundsAround(lon, lat, radiusM) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    west: Math.max(-180, lon - dLon),
    east: Math.min(180, lon + dLon),
    south: Math.max(-85, lat - dLat),
    north: Math.min(85, lat + dLat),
  };
}

/** One-line map label, or null when the station needs none. */
export function citsObjectLabel(object) {
  if (object.line)
    return object.destination
      ? `${object.line} → ${object.destination}`
      : String(object.line);
  return null;
}

/**
 * Compact report age, as the perimeter cards write it but with seconds, since
 * C-ITS stations report every second or so.
 * @param {number} deltaMs - Age in milliseconds.
 * @returns {string|null} `12s`, `4m`, `3h`, `2d`, or null when unknown.
 */
export function citsFormatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1000)}s`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h`;
  return `${Math.floor(deltaMs / 86_400_000)}d`;
}

/** Overlay source for the one click-selected station card. */
export const CITS_SELECTED_OVERLAY_SOURCE_ID = 'cits-selected';
const SELECTED_TITLE_CHARS = 32;
const SELECTED_SIGNAL_GROUPS = 4;

function boundTitle(text) {
  return text.length > SELECTED_TITLE_CHARS
    ? `${text.slice(0, SELECTED_TITLE_CHARS - 1)}…`
    : text;
}

/**
 * Build the overlay-host entry for the selected station. The caller supplies
 * `position` (a getter, since vehicles glide between reports), so this model
 * stays JSON-safe for tests.
 * @param {Object} object - Station record from the relay (never anonymous).
 * @param {number} [nowMs] - Current epoch milliseconds.
 * @returns {Object} Overlay entry without `position`.
 */
export function buildCitsSelectedCard(object, nowMs = Date.now()) {
  const kind =
    object.kind === 'hazard'
      ? 'HAZARD'
      : citsKindLabel(object.kind).toUpperCase();
  const subject =
    object.kind === 'hazard'
      ? object.name
      : citsObjectLabel(object) || object.name;
  const title = boundTitle(subject ? `${kind} · ${subject}` : kind);

  const facts = [];
  if (object.kind === 'hazard') facts.push('DENM warning');
  if (object.vehicleNumber) facts.push(`vehicle ${object.vehicleNumber}`);
  if (Number.isFinite(object.speedKmh))
    facts.push(`${Math.round(object.speedKmh)} km/h`);
  if (Number.isFinite(object.heading))
    facts.push(`${Math.round(object.heading)}°`);
  if (Number.isFinite(object.speedLimit))
    facts.push(`limit ${object.speedLimit} km/h`);

  const details = [];
  if (facts.length) details.push(facts.join(' · '));
  if (Array.isArray(object.spat) && object.spat.length) {
    const groups = object.spat.slice(0, SELECTED_SIGNAL_GROUPS).map((group) => {
      const info = citsSignalState(group.state);
      return `${group.group} ${info ? info.label : '–'}`;
    });
    const more = object.spat.length - SELECTED_SIGNAL_GROUPS;
    details.push(
      `signal ${groups.join(' · ')}${more > 0 ? ` · +${more} more` : ''}`,
    );
  }
  if (object.kind !== 'hazard') details.push(`station ${object.id}`);
  const age = citsFormatAge(nowMs - Date.parse(object.lastSeen || ''));
  const provenance = [
    age ? `heard ${age} ago` : null,
    'OpenTrafficMap receivers',
  ].filter(Boolean);
  if (object.stale) provenance.push('STALE');
  details.push(provenance.join(' · '));

  return {
    id: `cits-card:${object.id}`,
    variant: 'selected',
    selected: true,
    protected: true,
    interactive: false,
    title,
    details,
    accent: citsDotStyle(object).css,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Kind groups the panel can switch on and off. */
export const CITS_KIND_GROUPS = Object.freeze([
  { id: 'car', label: 'Cars', kinds: ['car'] },
  { id: 'bus', label: 'Buses', kinds: ['bus'] },
  { id: 'tram', label: 'Trams', kinds: ['tram'] },
  {
    id: 'other',
    label: 'Other vehicles',
    kinds: [
      'heavy_truck',
      'light_truck',
      'special_vehicle',
      'motorcycle',
      'cyclist',
      'pedestrian',
      'unknown',
    ],
  },
  { id: 'traffic_light', label: 'Traffic lights', kinds: ['traffic_light'] },
  { id: 'rsu', label: 'Roadside units', kinds: ['rsu'] },
  { id: 'trailer', label: 'Warning trailers', kinds: ['trailer'] },
  { id: 'hazard', label: 'Hazards', kinds: ['hazard'] },
]);

const GROUP_BY_KIND = new Map(
  CITS_KIND_GROUPS.flatMap((group) =>
    group.kinds.map((kind) => [kind, group.id]),
  ),
);

/** Panel group for a station kind. */
export function citsKindGroup(kind) {
  return GROUP_BY_KIND.get(kind) || 'other';
}

/**
 * Row range chips: camera distances in km, plus the dot size factor. Each
 * click steps to the next value and wraps, so the row needs no slider.
 */
export const CITS_RANGE_SETTINGS = Object.freeze([
  {
    id: 'vehicleRangeKm',
    label: 'VEHICLE RANGE',
    title: 'Vehicles and hazards stay visible to this camera distance',
    unit: 'km',
    min: 2,
    max: 400,
    steps: Object.freeze([5, 15, 30, 60, 120, 400]),
  },
  {
    id: 'fixedRangeKm',
    label: 'LIGHT RANGE',
    title: 'Traffic lights, roadside units and trailers stay visible to',
    unit: 'km',
    min: 1,
    max: 400,
    steps: Object.freeze([2, 5, 10, 25, 50, 100]),
  },
  {
    id: 'labelRangeKm',
    label: 'LABEL RANGE',
    title: 'Line and hazard labels show to this camera distance',
    unit: 'km',
    min: 1,
    max: 60,
    steps: Object.freeze([2, 5, 10, 15, 30, 60]),
  },
  {
    id: 'bracketRangeKm',
    label: 'BRACKET RANGE',
    title: 'Tram brackets and callouts show to this camera distance',
    unit: 'km',
    min: 1,
    max: 40,
    steps: Object.freeze([2, 4, 8, 15, 30]),
  },
  {
    id: 'dotScale',
    label: 'DOT SIZE',
    title: 'Station dot size',
    unit: '×',
    min: 0.5,
    max: 2.5,
    steps: Object.freeze([0.75, 1, 1.5, 2, 2.5]),
  },
]);

/** Chip text for one range value: `60 km`, `1.5×`. */
export function citsFormatRange(spec, value) {
  return spec.unit === '×'
    ? `${Number.isInteger(value) ? value.toFixed(1) : String(value)}×`
    : `${value} ${spec.unit}`;
}

/** Next step after `value`, wrapping to the first. */
export function citsNextRangeStep(spec, value) {
  return spec.steps.find((step) => step > value + 1e-9) ?? spec.steps[0];
}

export const CITS_DEFAULT_SETTINGS = Object.freeze({
  vehicleRangeKm: 60,
  fixedRangeKm: 25,
  labelRangeKm: 15,
  bracketRangeKm: 8,
  dotScale: 1,
  lanes: true,
  groups: Object.freeze(
    Object.fromEntries(CITS_KIND_GROUPS.map((group) => [group.id, true])),
  ),
});

/** Merge a partial settings patch onto `current`, clamping every value. */
export function citsMergeSettings(current, patch = {}) {
  const next = {
    ...current,
    groups: { ...current.groups },
  };
  for (const spec of CITS_RANGE_SETTINGS) {
    const value = Number(patch[spec.id]);
    if (Number.isFinite(value))
      next[spec.id] = Math.min(spec.max, Math.max(spec.min, value));
  }
  if (typeof patch.lanes === 'boolean') next.lanes = patch.lanes;
  for (const [id, on] of Object.entries(patch.groups || {}))
    if (Object.hasOwn(next.groups, id) && typeof on === 'boolean')
      next.groups[id] = on;
  return next;
}
