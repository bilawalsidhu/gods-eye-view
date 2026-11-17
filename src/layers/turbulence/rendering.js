import { drawOf } from '../../render/rendererOf.js';
import { cssColor } from '../../render/color.js';
import { FEET_TO_METERS } from './records.js';
import { severityColor } from './model.js';

/**
 * The draw sets start with this; each layer has its own
 * (`weather-turbulence:1:warnings`, …), so several can share a renderer.
 */
export const TURBULENCE_SET_PREFIX = 'weather-turbulence';
/**
 * Floors at the surface are buried this far below the ellipsoid, so a slab
 * from SFC never hovers over coastal 3D tiles; the buried part is hidden by
 * the depth test.
 */
export const SURFACE_FLOOR_M = -300;
const FORECAST_ALPHA = 0.18;
const WARNING_ALPHA = 0.26;
const REPORT_PIXELS = 9;
let instances = 0;

const withAlpha = ([r, g, b], alpha) => [r, g, b, alpha];

/** Metres above the ellipsoid of a record's floor and top. */
export function volumeHeights(record) {
  return {
    floor: record.baseIsSurface
      ? SURFACE_FLOOR_M
      : record.baseFt * FEET_TO_METERS,
    top: record.topFt * FEET_TO_METERS,
  };
}

/** One extruded, flat-shaded, translucent volume per polygon of a record. */
export function volumeItems(record, alpha) {
  const { floor, top } = volumeHeights(record);
  const fill = withAlpha(cssColor(severityColor(record.severity)), alpha);
  return record.polygons.map((rings, index) => ({
    id: `${record.id}#${index}`,
    geometry: {
      kind: 'polygon',
      rings: rings.map((ring) =>
        ring.map(([lon, lat]) => ({ lon, lat, height: floor })),
      ),
    },
    fill,
    extrudeHeight: top,
    height: 'absolute',
    lit: false,
    pickable: false,
  }));
}

/**
 * One point at the reported flight level. Drawn over depth: zoomed out, a
 * few pixels span kilometres, so a dot a few kilometres up would otherwise
 * be cut by the globe or tiles beneath it. Its set culls it past the
 * horizon instead.
 */
export function reportItem(record) {
  return {
    id: record.id,
    pos: {
      lon: record.lon,
      lat: record.lat,
      height: record.baseFt * FEET_TO_METERS,
    },
    height: 'absolute',
    disableDepthTest: Number.POSITIVE_INFINITY,
    pixelSize: REPORT_PIXELS,
    color: cssColor(severityColor(record.severity)),
    outlineColor: [0, 0, 0, 0.85],
    outlineWidth: 1.5,
  };
}

const recordsKey = (records) =>
  records
    .map(
      (r) => `${r.id}:${r.severity}:${r.baseFt}:${r.topFt}:${r.issuedAt ?? ''}`,
    )
    .join('|');

/**
 * Own the turbulence draw sets of one viewer.
 *
 * Every extruded shape is its own renderer primitive, built on the main
 * thread, so the forecast hours each get a set built once per refresh and a
 * timeline scrub only switches which one shows. Warnings and reports are
 * redrawn only when what is in force changes. Volumes take no part in picks:
 * a pickable slab would cover every aircraft and satellite inside it.
 *
 * Every set is made when it first has something to draw and disposed by
 * `clear`, so a layer turned off leaves nothing in the scene.
 */
export function createTurbulenceRendering({ viewer }) {
  const draw = drawOf(viewer);
  const prefix = `${TURBULENCE_SET_PREFIX}:${++instances}`;
  /** @type {Map<number, {set: object, key: string}>} */
  const forecastSets = new Map();
  let warnings = null;
  let reports = null;
  const warningsSet = () =>
    (warnings ??= draw.shapes({
      id: `${prefix}:warnings`,
      blend: 'translucent',
      pickable: false,
      show: visible,
    }));
  const reportsSet = () =>
    (reports ??= draw.points({
      id: `${prefix}:reports`,
      // Drawn without depth test, so hidden past the horizon here.
      horizonCull: true,
      show: visible,
    }));
  let visible = false;
  let shownForecast = null;
  let warningsKey = null;
  let reportsKey = null;
  let builds = 0;

  function syncForecastVisibility() {
    for (const [validAt, entry] of forecastSets)
      entry.set.show = visible && validAt === shownForecast;
  }

  return {
    /**
     * Build the forecast sets from every filtered snapshot of a refresh.
     * Hours whose records did not change keep their set as it is.
     * @param {object[]} records forecast records of all hours
     */
    setForecasts(records) {
      const byHour = new Map();
      for (const record of records) {
        const list = byHour.get(record.validAt) ?? [];
        list.push(record);
        byHour.set(record.validAt, list);
      }
      for (const [validAt, entry] of forecastSets) {
        if (byHour.has(validAt)) continue;
        entry.set.dispose();
        forecastSets.delete(validAt);
      }
      for (const [validAt, list] of byHour) {
        const key = recordsKey(list);
        let entry = forecastSets.get(validAt);
        if (entry?.key === key) continue;
        if (!entry) {
          entry = {
            set: draw.shapes({
              id: `${prefix}:forecast:${validAt}`,
              blend: 'translucent',
              pickable: false,
              show: false,
            }),
            key: null,
          };
          forecastSets.set(validAt, entry);
        }
        entry.set.set(list.flatMap((r) => volumeItems(r, FORECAST_ALPHA)));
        entry.key = key;
        builds++;
      }
      syncForecastVisibility();
    },
    /** Show the forecast hour valid at `validAt` (null: none). */
    showForecast(validAt) {
      shownForecast = validAt;
      syncForecastVisibility();
    },
    /** Draw the warnings in force; unchanged ones are not rebuilt. */
    setWarnings(records) {
      const key = recordsKey(records);
      if (key === warningsKey) return;
      warningsKey = key;
      if (!records.length && !warnings) return;
      warningsSet().set(records.flatMap((r) => volumeItems(r, WARNING_ALPHA)));
      builds++;
    },
    /** Draw the reports in the window; unchanged ones are not rewritten. */
    setReports(records) {
      const key = recordsKey(records);
      if (key === reportsKey) return;
      reportsKey = key;
      if (!records.length && !reports) return;
      reportsSet().set(records.map(reportItem));
    },
    setVisible(on) {
      visible = Boolean(on);
      if (warnings) warnings.show = visible;
      if (reports) reports.show = visible;
      syncForecastVisibility();
    },
    /**
     * Whether a click's draw hit is one of the volumes. They are drawn
     * unpickable; a renderer that picks them anyway must not make a click
     * inside one read as something else under the click.
     */
    isVolumeHit(hit) {
      if (!hit || hit.surface || typeof hit.set !== 'string') return false;
      if (warnings && hit.set === warnings.id) return true;
      for (const entry of forecastSets.values())
        if (entry.set.id === hit.set) return true;
      return false;
    },
    /** The report id a click's draw hit names, or null. */
    pickReport(hit) {
      if (!hit || hit.surface || !reports || hit.set !== reports.id)
        return null;
      return typeof hit.id === 'string' ? hit.id : null;
    },
    /** Dispose every set: nothing of the layer is left in the scene. */
    clear() {
      for (const entry of forecastSets.values()) entry.set.dispose();
      forecastSets.clear();
      warnings?.dispose();
      reports?.dispose();
      warnings = reports = null;
      warningsKey = reportsKey = null;
      shownForecast = null;
    },
    getDiagnostics() {
      return {
        forecastSets: forecastSets.size,
        shownForecast,
        builds,
        visible,
      };
    },
    destroy() {
      for (const entry of forecastSets.values()) entry.set.dispose();
      forecastSets.clear();
      warnings?.dispose();
      reports?.dispose();
      warnings = reports = null;
    },
  };
}
