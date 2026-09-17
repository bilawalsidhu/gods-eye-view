import { captureLocalViewport, airlineFromCallsign } from './localVision.js';
import { isLocalTool } from './localToolSchemas.js';
import { packHandlers } from './tools/index.js';
import {
  haversineKm,
  matchesFilter,
  resolveScope,
  inScope,
  withDistance,
} from './watchEngine.js';

/**
 * Browser-side implementations of the local-only voice tools. The adapter
 * routes these names here; everything else goes to the upstream action
 * runner. Globe access goes through the same window handle the QA harness
 * uses so no shell wiring is needed.
 */
export function createLocalTools({
  memory,
  watches,
  getGlobe = () => globalThis.window?.__godsEyeView || null,
  getTimeTravel = () => globalThis.window?.__gevTimeTravel || null,
  runner = null,
  captureImage = captureLocalViewport,
  speakHook = null,
} = {}) {
  const camera = () => {
    try {
      return getGlobe()?.styleManager?.getCameraState?.() || null;
    } catch {
      return null;
    }
  };

  const handlers = {
    async remember_place({ name }) {
      const state = camera();
      if (!state) return { ok: false, error: 'Camera position unavailable' };
      const place = memory.rememberPlace(name, state);
      if (!place) return { ok: false, error: 'A name is required' };
      return { ok: true, saved: place.name, altitudeM: Math.round(place.alt) };
    },
    async go_to_saved_place({ name }) {
      const place = memory.recallPlace(name);
      if (!place)
        return {
          ok: false,
          error: `No saved place matches "${name}"`,
          savedPlaces: memory.listPlaces().map((p) => p.name),
        };
      const shell = getGlobe()?.styleManager;
      if (typeof shell?.applyCameraState !== 'function')
        return { ok: false, error: 'Camera control unavailable' };
      shell.applyCameraState(place, 2.4);
      memory.noteTarget({ kind: 'place', id: place.name, label: place.name });
      return { ok: true, flyingTo: place.name };
    },
    async list_saved_places() {
      const places = memory.listPlaces().map((p) => p.name);
      return { ok: true, count: places.length, places };
    },
    async forget_place({ name }) {
      return { ok: memory.forgetPlace(name), name };
    },
    async recall_recent_target({ kind = 'any', query = '' } = {}) {
      let items = memory.recentTargets(kind === 'any' ? null : kind);
      const q = String(query || '')
        .toLowerCase()
        .trim();
      if (q) items = items.filter((i) => i.label.toLowerCase().includes(q));
      return {
        ok: true,
        count: items.length,
        targets: items.slice(0, 8).map((i) => ({
          kind: i.kind,
          id: i.id,
          label: i.label,
          layerId: i.layerId,
          minutesAgo: Math.round((Date.now() - i.at) / 60000),
        })),
        hint: 'Use track_entity with the id for aircraft/vessels, or fly_to_location with the label for places.',
      };
    },
    async ask_about_view({ question }) {
      const dataUrl = await captureImage();
      if (!dataUrl)
        return {
          ok: false,
          error: 'Could not capture the view (hidden tab or dark frame)',
        };
      let context = null;
      if (runner) {
        try {
          const view = await runner('get_current_view_state', {}, {});
          context = {
            camera: view?.camera,
            style: view?.style,
            tracked: view?.tracked,
            layers: (view?.layers || [])
              .filter((l) => l.enabled)
              .map((l) => l.name),
            place:
              view?.context?.place || view?.context?.basemap?.place || null,
          };
        } catch {
          /* vision still works without structured context */
        }
      }
      return {
        ok: true,
        vision: true,
        question,
        image: dataUrl.replace(/^data:image\/[a-z]+;base64,/, ''),
        context,
      };
    },
    async data_report(args) {
      return dataReport(args, { getGlobe, camera });
    },
    async watch_add(args) {
      try {
        return { ok: true, watch: watches.add(args) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    async watch_list() {
      const list = watches.list();
      return { ok: true, count: list.length, watches: list };
    },
    async watch_clear({ id } = {}) {
      return { ok: true, removed: watches.clear(id) };
    },
    async rewind_time({ minutes = 10, rate = 1 } = {}) {
      const travel = getTimeTravel();
      if (!travel)
        return {
          ok: false,
          error: 'Time travel is not available in this build',
        };
      const range = travel.range?.();
      const available = range?.oldestT
        ? (Date.now() - range.oldestT) / 60000
        : 0;
      const requested = Math.min(minutes, 15);
      const applied = Math.min(requested, Math.max(available, 0));
      if (applied < 0.25)
        return {
          ok: false,
          error: 'No position history recorded yet; try again in a minute',
        };
      travel.rewind(-Math.round(applied * 60000));
      if (Number.isFinite(rate)) travel.setRate?.(rate);
      return {
        ok: true,
        rewoundMinutes: Math.round(applied * 10) / 10,
        rate,
        availableMinutes: Math.round(available * 10) / 10,
      };
    },
    async resume_live() {
      const travel = getTimeTravel();
      if (!travel)
        return {
          ok: false,
          error: 'Time travel is not available in this build',
        };
      travel.resumeLive();
      return { ok: true };
    },
  };

  Object.assign(
    handlers,
    packHandlers({
      memory,
      watches,
      getGlobe,
      getTimeTravel,
      runner,
      captureImage,
      camera,
      // kind: 'alert' (warning prefix, forwarded to peers) or 'info'
      // (briefings, narration). Defaults to info.
      speak: (text, opts) => speakHook?.(text, opts),
      fetchJson: async (url, body) => {
        const response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(data?.error || `HTTP ${response.status} from ${url}`);
        return data;
      },
    }),
  );

  return {
    has: (name) => isLocalTool(name) && typeof handlers[name] === 'function',
    async run(name, args = {}) {
      const handler = handlers[name];
      if (!handler) return { ok: false, error: `Unknown local tool ${name}` };
      try {
        return await handler(args || {});
      } catch (error) {
        return {
          ok: false,
          error: error?.message || String(error),
          tool: name,
        };
      }
    },
    /** Remember navigation and tracking results for later recall. */
    noteActionResult(name, args, result) {
      if (!result || result.ok === false) return;
      if (name === 'fly_to_location') {
        const label = result.label || args?.query || args?.locationId;
        if (label)
          memory.noteTarget({
            kind: 'place',
            id: result.locationId || null,
            label,
          });
      } else if (
        name === 'track_entity' ||
        name === 'select_nearest_aircraft'
      ) {
        const kind =
          result.kind ||
          (result.mmsi ? 'vessel' : result.noradId ? 'satellite' : 'aircraft');
        const id =
          result.id ||
          result.icao24 ||
          result.mmsi ||
          result.noradId ||
          args?.query ||
          null;
        const label = result.label || result.callsign || result.name || id;
        if (label)
          memory.noteTarget({
            kind,
            id,
            label,
            layerId: result.layerId || null,
          });
      }
    },
  };
}

const NUMERIC_DEFAULT_FIELD = {
  flights: 'altitudeM',
  military: 'altitudeM',
  'ais-live-vessels': 'speedKts',
  earthquakes: 'mag',
  'local-firms': 'frp',
  cctv: null,
};

export async function dataReport(
  {
    layer,
    scope,
    filters = [],
    groupBy,
    metric = 'count',
    field,
    limit = 10,
  } = {},
  { getGlobe, camera },
) {
  const globe = getGlobe();
  const dataManager = globe?.dataManager;
  if (!dataManager) return { ok: false, error: 'Data manager unavailable' };
  if (!dataManager.isEnabled?.(layer))
    return {
      ok: false,
      error: `Layer ${layer} is off; enable it with set_layer_visibility first`,
    };
  const module = dataManager.layers?.get?.(layer)?.module;
  let rows = [];
  if (layer === 'cctv') rows = cctvRecords(module, globe);
  else if (typeof module?.getAnalystRecords === 'function')
    rows = module.getAnalystRecords(5000) || [];
  else return { ok: false, error: `Layer ${layer} has no queryable records` };
  if (
    (layer === 'flights' || layer === 'military') &&
    typeof module?.getAllPositions === 'function'
  ) {
    // OpenSky records rarely carry an operator; enrichment on the rendered
    // positions has airline and aircraft type keyed by the same id.
    const extras = new Map();
    for (const p of module.getAllPositions(5000) || [])
      extras.set(String(p.id), p);
    rows = rows.map((r) => {
      const extra = extras.get(String(r.id));
      return extra
        ? {
            ...r,
            operator:
              r.operator ||
              extra.airline ||
              airlineFromCallsign(r.callsign) ||
              null,
            aircraftType: extra.typeName || extra.typeCode || null,
            routeOrigin: r.routeOrigin || extra.origin || null,
            routeDestination: r.routeDestination || extra.destination || null,
          }
        : {
            ...r,
            operator: r.operator || airlineFromCallsign(r.callsign) || null,
          };
    });
  }
  const resolved = resolveScope(scope, camera());
  const matched = withDistance(rows, resolved, camera()).filter(
    (r) =>
      inScope(r, resolved) && (filters || []).every((f) => matchesFilter(r, f)),
  );
  const numericField = field || NUMERIC_DEFAULT_FIELD[layer];
  const report = {
    ok: true,
    layer,
    scope: resolved
      ? { kind: scope.kind, radiusKm: Math.round(resolved.km) }
      : { kind: 'anywhere' },
    loaded: rows.length,
    matched: matched.length,
  };
  if (groupBy) {
    const groups = new Map();
    for (const r of matched) {
      const key =
        groupBy === 'cell' ? cellKey(r) : String(r[groupBy] ?? 'unknown');
      const bucket = groups.get(key) || { key, count: 0, values: [] };
      bucket.count++;
      if (numericField && Number.isFinite(r[numericField]))
        bucket.values.push(r[numericField]);
      groups.set(key, bucket);
    }
    report.groups = [...groups.values()]
      .map((g) => ({
        key: g.key,
        count: g.count,
        ...(metric !== 'count' && g.values.length
          ? { [metric]: aggregate(metric, g.values) }
          : {}),
      }))
      .sort((a, b) =>
        metric === 'count'
          ? b.count - a.count
          : (b[metric] ?? 0) - (a[metric] ?? 0),
      )
      .slice(0, limit);
    report.groupBy = groupBy;
  } else if (metric !== 'count' && numericField) {
    const values = matched.map((r) => r[numericField]).filter(Number.isFinite);
    report.metric = {
      [metric]: aggregate(metric, values),
      field: numericField,
      samples: values.length,
    };
  }
  const center =
    resolved || (camera() && { lat: camera().lat, lon: camera().lon });
  report.top = matched
    .map((r) => ({
      id: r.id,
      label: r.callsign || r.name || r.place || r.id,
      ...(r.operator ? { operator: r.operator } : {}),
      ...(Number.isFinite(r.altitudeM)
        ? { altitudeM: Math.round(r.altitudeM) }
        : {}),
      ...(Number.isFinite(r.speedKts)
        ? { speedKts: Math.round(r.speedKts) }
        : {}),
      ...(r.destination ? { destination: r.destination } : {}),
      ...(Number.isFinite(r.mag) ? { mag: r.mag } : {}),
      ...(center && Number.isFinite(r.lat)
        ? {
            distanceKm: Math.round(
              haversineKm(r.lat, r.lon, center.lat, center.lon),
            ),
          }
        : {}),
    }))
    .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
    .slice(0, Math.min(limit, 8));
  return report;
}

function aggregate(metric, values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  const result =
    metric === 'avg'
      ? sum / values.length
      : metric === 'sum'
        ? sum
        : metric === 'min'
          ? Math.min(...values)
          : Math.max(...values);
  return Math.round(result * 10) / 10;
}

function cellKey(record) {
  if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
    return 'unknown';
  const lat = Math.floor(record.lat);
  const lon = Math.floor(record.lon);
  return `${lat >= 0 ? lat + 'N' : -lat + 'S'} ${lon >= 0 ? lon + 'E' : -lon + 'W'}`;
}

/** CCTV has no analyst records; derive lat/lon from its detectable objects. */
function cctvRecords(module, globe) {
  const objects = module?.getDetectableObjects?.({ maxCount: 20000 }) || [];
  const ellipsoid = globe?.viewer?.scene?.globe?.ellipsoid;
  const out = [];
  for (const object of objects) {
    const carto = ellipsoid?.cartesianToCartographic?.(object.position);
    if (!carto) continue;
    out.push({
      id: object.sourceId || object.id,
      lat: (carto.latitude * 180) / Math.PI,
      lon: (carto.longitude * 180) / Math.PI,
    });
  }
  return out;
}
