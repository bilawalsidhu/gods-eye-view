import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * @file TomTom traffic-flow vector-tile client: fetch + MVT decode.
 *
 * Fetches flow tiles from the local `/api/tomtom/flow/{z}/{x}/{y}.pbf` proxy
 * (the TomTom key never reaches the browser) and decodes the Mapbox Vector
 * Tile layer "Traffic flow" into plain lon/lat polylines with congestion
 * attributes. Consumed by the traffic layer's live mode
 * for matching congestion onto OpenStreetMap roads.
 *
 * Segment shape: `{coords: [[lon,lat],…], trafficLevel: 0..1, roadType: string,
 * closure: boolean}` — `trafficLevel` is TomTom's current/free-flow speed
 * ratio (1 = free flow). Features with a missing/non-finite `traffic_level`
 * are skipped unless `road_closure` is true (closures decode with level 0).
 *
 * The proxy serves tiles from either TomTom flow endpoint, and they name
 * things differently. TomTom Maps (`traffic/map/4`, style `relative`):
 * `traffic_level`, `road_type` ("Motorway", "Major road", …) and
 * `traffic_road_coverage` (`full` when one line carries both directions).
 * TomTom Orbis Maps (`maps/orbis/traffic`, apiVersion 2): `relative_speed`
 * (the same ratio), `road_category` (OpenStreetMap-style, with `_link`
 * ramps) and one line per travel direction. Orbis features are decoded into
 * the TomTom Maps vocabulary, so nothing downstream tells them apart.
 *
 * Deps: `pbf@5` (PbfReader) + `@mapbox/vector-tile@3` — both tiny and
 * tree-shakeable; decoding happens client-side so the proxy stays a dumb
 * binary cache.
 *
 * @module layers/traffic/flowDecode
 */

const FLOW_LAYER_NAME = 'Traffic flow';

/**
 * Orbis `road_category` → the TomTom Maps `road_type` and `road_category`
 * the traffic layer classifies roads by. A ramp takes its road's class;
 * service roads and tracks stay unmapped, as TomTom Maps tiles left
 * parking and private roads out of the drivable set.
 */
const ORBIS_ROAD_CATEGORIES = Object.freeze({
  motorway: ['Motorway', 'motorway'],
  trunk: ['International road', 'trunk'],
  primary: ['Major road', 'primary'],
  secondary: ['Secondary road', 'secondary'],
  tertiary: ['Connecting road', 'tertiary'],
  street: ['Local road', 'street'],
});

/** Road class of a feature, in TomTom Maps terms, from either schema. */
function roadClassOf(props) {
  if (typeof props.road_type === 'string')
    return [props.road_type, props.road_category ?? null];
  const category =
    typeof props.road_category === 'string'
      ? props.road_category.replace(/_link$/, '')
      : null;
  if (category && Object.hasOwn(ORBIS_ROAD_CATEGORIES, category))
    return ORBIS_ROAD_CATEGORIES[category];
  // Kept as sent, so the drivable filter drops it by category.
  return ['', props.road_category ?? null];
}
/** Decode flow geometry; strict mode distinguishes damaged tiles from valid empty coverage. */
export function decodeFlowTile(data, z, x, y, { strict = false } = {}) {
  let layer;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const tile = new VectorTile(new PbfReader(bytes));
    layer = tile.layers[FLOW_LAYER_NAME];
  } catch {
    if (strict) throw new Error('Malformed TomTom flow tile');
    return [];
  }
  if (!layer) return [];

  const segments = [];
  for (let i = 0; i < layer.length; i++) {
    let feature;
    let geometry;
    try {
      feature = layer.feature(i);
      geometry = feature.toGeoJSON(x, y, z).geometry;
    } catch {
      continue; // one malformed feature must not drop the tile
    }
    const props = feature.properties || {};
    const closure =
      props.road_closure === true || props.road_closure === 'true';
    const orbis =
      props.traffic_level === undefined && props.road_type === undefined;
    const rawLevel = orbis ? props.relative_speed : props.traffic_level;
    const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
    // Skip features we can't color — unless closed (closures render dot-free
    // regardless of level, so they stay useful without one).
    if (!hasLevel && !closure) continue;
    const trafficLevel = hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0;
    const [roadType, roadCategory] = roadClassOf(props);

    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      segments.push({
        coords,
        trafficLevel,
        roadType,
        roadCategory,
        roadSubcategory: props.road_subcategory ?? null,
        closure,
        // Orbis draws each travel direction as its own line.
        coverage: props.traffic_road_coverage ?? (orbis ? 'one_side' : null),
        leftHandTraffic:
          props.left_hand_traffic === true ||
          props.left_hand_traffic === 'true',
      });
    }
  }
  return segments;
}
