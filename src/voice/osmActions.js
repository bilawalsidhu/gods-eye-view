/**
 * `osm_query`: find OpenStreetMap features of one curated kind inside an area
 * handle or the view ("all hospitals in Kathmandu"), show them in the OSM
 * Places layer, and leave them queryable by analyst_query.
 *
 * The server searches the area's bounding box (bounded size, one preset);
 * this keeps only features inside the area's own geometry, so a count inside
 * a province is exact. An area too large to list is counted over its bounding
 * box instead, and the answer says so.
 *
 * Bulk search needs an operator-configured Overpass (`OVERPASS_UPSTREAMS`):
 * without one the tool is left out of the voice session, and the server
 * route refuses with OVERPASS_NOT_CONFIGURED. Public Nominatim is never used
 * for it.
 *
 * @module voice/osmActions
 */

import { matchOsmPreset, OSM_PRESETS } from '../data/osmPresets.js';
import { pointInPreparedArea } from '../data/areaGeometry.js';
import {
  dedupeOsmRecords,
  mapOsmFeature,
  OSM_PLACES_LAYER_ID,
} from '../layers/osmPlaces/model.js';
import {
  displacedLayerResult,
  watchExplicitLayerOff,
} from './layerActionOwnership.js';

export const OSM_QUERY_LIMITS = Object.freeze({
  /** Mirrors the server: largest box listed, and largest box counted (deg²). */
  maxFetchDeg2: 4,
  maxCountDeg2: 36,
  defaultLimit: 500,
  maxLimit: 1000,
  /** The answer waits this long before cancelling its provider request. */
  budgetMs: 25_000,
});

/** Area of a [west, south, east, north] box in square degrees (antimeridian-aware). */
export function boxDeg2([west, south, east, north]) {
  const width = west <= east ? east - west : 180 - west + (east + 180);
  return width * (north - south);
}

/** "pharmacies" → "pharmacy", "hospitals" → "hospital". */
function singularLabel(label) {
  if (label.endsWith('ies')) return `${label.slice(0, -3)}y`;
  return label.endsWith('s') ? label.slice(0, -1) : label;
}

/** Places a result numbers for "the second one" (the card shows these). */
const MAX_REFERENTS = 5;

const EXAMPLES = Object.values(OSM_PRESETS)
  .slice(0, 12)
  .map((preset) => preset.label)
  .join(', ');

/**
 * Run one `osm_query`.
 * @param {object} deps
 * @param {object} deps.dataManager
 * @param {(areaId: string) => object|null} deps.getArea
 * @param {() => number[]|null} deps.viewBox Current view as [w, s, e, n].
 * @param {(enabled: boolean) => Promise<object>} deps.enableLayer
 * @param {Function} deps.search `/api/osm/features` client.
 * @param {() => void} [deps.onCredit] Registers the OpenStreetMap credit.
 * @param {(rows: object[]|null) => void} [deps.rememberResults] Hands the
 *   listed places to analyst follow-ups; null forgets the previous set.
 * @param {(step: string, label?: string) => void} [deps.progress]
 * @param {object} args
 * @param {{isCurrent?: () => boolean, budgetMs?: number, signal?: AbortSignal}} [options]
 */
export async function osmQuery(
  {
    dataManager,
    getArea,
    viewBox,
    enableLayer,
    search,
    onCredit = () => {},
    rememberResults = () => {},
    progress = () => {},
  },
  args = {},
  {
    isCurrent = () => true,
    budgetMs = OSM_QUERY_LIMITS.budgetMs,
    signal = null,
  } = {},
) {
  const fail = (code, error, extra = {}) => ({
    ok: false,
    action: 'osm_query',
    code,
    error,
    ...extra,
  });
  const cancelled = () =>
    fail('CANCELLED', 'This request was superseded.', { cancelled: true });
  const preset = matchOsmPreset(args.what);
  if (!preset)
    return fail(
      'UNKNOWN_KIND',
      `I can search OpenStreetMap for kinds like ${EXAMPLES}. Say which.`,
    );

  let bbox;
  let area = null;
  let areaName;
  if (args.areaId) {
    area = getArea(args.areaId);
    if (!area)
      return fail(
        'AREA_UNKNOWN',
        `No area "${args.areaId}" on this page — call resolve_area again.`,
      );
    bbox = area.bbox;
    areaName = area.name;
  } else {
    bbox = viewBox();
    if (!bbox) return fail('NO_VIEW', 'Point the camera at the ground first.');
    areaName = 'the view';
  }
  const deg2 = boxDeg2(bbox);
  if (deg2 > OSM_QUERY_LIMITS.maxCountDeg2)
    return fail(
      'AREA_TOO_LARGE',
      `${areaName} is too large to search — name a smaller area or zoom in.`,
    );
  const listable = deg2 <= OSM_QUERY_LIMITS.maxFetchDeg2;
  const limit = Math.max(
    1,
    Math.min(
      OSM_QUERY_LIMITS.maxLimit,
      Number(args.limit) || OSM_QUERY_LIMITS.defaultLimit,
    ),
  );

  const initiallyEnabled = Boolean(
    dataManager?.isEnabled?.(OSM_PLACES_LAYER_ID),
  );
  const controller = new AbortController();
  const cancelProvider = () => controller.abort();
  signal?.addEventListener?.('abort', cancelProvider, { once: true });
  if (signal?.aborted) cancelProvider();
  const offWatch = watchExplicitLayerOff(dataManager, OSM_PLACES_LAYER_ID, {
    onOff: () => controller.abort(),
  });
  const displaced = () =>
    displacedLayerResult(
      dataManager,
      OSM_PLACES_LAYER_ID,
      'osm_query',
      'OSM Places was turned off while I searched, so I left it off and discarded the result.',
    );
  const wasDisplaced = () =>
    offWatch.requested() ||
    (initiallyEnabled && !dataManager?.isEnabled?.(OSM_PLACES_LAYER_ID));
  try {
    progress('osm', preset.label);
    let timer;
    const answer = await Promise.race([
      search(
        {
          preset: preset.id,
          bbox,
          mode: listable ? 'features' : 'count',
          limit,
        },
        { signal: controller.signal },
      ).catch((error) => ({ ok: false, error: error?.message })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), budgetMs);
      }),
    ]);
    clearTimeout(timer);
    if (wasDisplaced()) return displaced();
    if (!isCurrent()) return cancelled();
    if (answer.timeout) {
      controller.abort();
      return fail(
        'OSM_TIMEOUT',
        'OpenStreetMap did not answer in time; ask again in a moment.',
      );
    }
    // The tool is only offered with an operator Overpass; if it is called
    // anyway, say so plainly rather than as a transient failure.
    if (answer.code === 'OVERPASS_NOT_CONFIGURED')
      return fail(
        'OVERPASS_NOT_CONFIGURED',
        'Place search needs a configured Overpass server.',
      );
    if (!answer.ok)
      return fail(
        answer.status === 429 || answer.status === 503
          ? 'OSM_BUSY'
          : 'OSM_UNAVAILABLE',
        answer.error || 'OpenStreetMap search failed.',
      );

    if (!listable) {
      if (wasDisplaced()) return displaced();
      // Nothing listed, so "those" names nothing a follow-up could filter.
      rememberResults(null);
      const count = answer.count;
      return {
        ok: true,
        action: 'osm_query',
        kind: preset.label,
        count,
        complete: false,
        countScope: 'bounding-box',
        area: areaName,
        shown: false,
        say: area
          ? `About ${count?.toLocaleString('en-US') ?? 'an unknown number of'} ${preset.label} in the rectangle around ${areaName} — too large to list; name a smaller area to see them.`
          : `About ${count?.toLocaleString('en-US') ?? 'an unknown number of'} ${preset.label} in view — too many to list; zoom in to see them.`,
        display: {
          source: 'OpenStreetMap',
          caveat: `counted over the bounding box of ${areaName}, not its outline`,
        },
      };
    }

    const inside = (feature) =>
      !area?.prepared ||
      pointInPreparedArea(area.prepared, feature.lat, feature.lon);
    const mapped = (answer.features || [])
      .filter(inside)
      .map((feature) => mapOsmFeature(feature, preset))
      .filter(Boolean);
    const { records, merged } = dedupeOsmRecords(mapped);
    const complete = !answer.truncated;

    let shown = false;
    if (!args.countOnly) {
      const layer = dataManager?.layers?.get(OSM_PLACES_LAYER_ID)?.module;
      if (layer?.setResults) {
        if (!dataManager.isEnabled?.(OSM_PLACES_LAYER_ID)) {
          const enabled = await enableLayer(true);
          if (wasDisplaced()) return displaced();
          if (!isCurrent()) return cancelled();
          if (enabled?.ok === false)
            return fail('LAYER_OFF', enabled.error || 'OSM Places is off.');
        }
        if (wasDisplaced()) return displaced();
        layer.setResults(records, {
          kind: preset.id,
          label: preset.label,
          area: areaName,
        });
        shown = true;
        onCredit();
      }
    }
    if (wasDisplaced()) return displaced();
    // These places are now "the last answer": follow-ups filter them and
    // "the second one" is the second row below.
    rememberResults(records);
    const unnamed = `unnamed ${singularLabel(preset.label)}`;
    const referents = [
      ...records.filter((r) => r.name),
      ...records.filter((r) => !r.name),
    ]
      .slice(0, MAX_REFERENTS)
      .map((r, index) => ({
        n: index + 1,
        id: r.id,
        label: r.name || unnamed,
        layerId: OSM_PLACES_LAYER_ID,
        lat: Math.round(r.lat * 1e4) / 1e4,
        lon: Math.round(r.lon * 1e4) / 1e4,
      }));
    const count = records.length;
    return {
      ok: true,
      action: 'osm_query',
      kind: preset.label,
      count,
      complete,
      area: areaName,
      ...(area?.areaId ? { areaId: area.areaId } : {}),
      shown,
      ...(shown ? { layerId: OSM_PLACES_LAYER_ID } : {}),
      referents,
      say: `${complete ? '' : 'At least '}${count.toLocaleString('en-US')} ${count === 1 ? singularLabel(preset.label) : preset.label} ${area ? `in ${areaName}` : 'in view'}, per OpenStreetMap`,
      display: {
        source: 'OpenStreetMap',
        ...(merged ? { merged: `${merged} duplicate mappings merged` } : {}),
        caveat: complete
          ? 'OpenStreetMap coverage varies by place'
          : `listed the first ${limit}; there are more`,
      },
    };
  } finally {
    signal?.removeEventListener?.('abort', cancelProvider);
    offWatch.stop();
  }
}
