/**
 * USGS water levels, nationwide: rivers & streams, lakes & reservoirs, springs.
 *
 * The server (server/providers/usgsWater.js) refreshes the newest USGS
 * readings hourly and serves one file per site class under /api/usgs-water/.
 * Streams are about ten thousand gauges, so they are also cut into 4-degree
 * tiles and this module loads ONLY the tiles that intersect the camera's view
 * rectangle, re-loading when the camera settles. When zoomed out past
 * STREAM_MAX_VIEW_DEG the stream layer loads nothing and asks the user to zoom
 * in, rather than pulling every gauge.
 *
 * The small classes (lakes/reservoirs, springs) load whole, but still
 * re-fetch on every enable so the hourly refresh shows up without a reload.
 */
import * as Cesium from 'cesium';
import { msg } from '../../i18n/marker.js';
import { createLocalGeoJsonLayer } from '../../data/localGeojsonCore.js';

export const USGS_WATER_BASE = '/api/usgs-water';
/** Wider than this many degrees (lon or lat span) → streams wait for zoom-in. */
export const STREAM_MAX_VIEW_DEG = 24;
/** Hard ceiling on stream tiles fetched for one view. */
export const STREAM_MAX_TILES = 40;

const SOURCE = 'USGS Water Data · refreshed hourly';

/** Water layers in panel order. `cls` matches the server classes. */
export const USGS_WATER_LAYERS = Object.freeze([
  Object.freeze({
    id: 'local-usgs-water',
    cls: 'stream',
    name: 'USGS Rivers & Streams',
    color: '#33ffaa',
    viewport: true,
  }),
  Object.freeze({
    id: 'local-usgs-lakes',
    cls: 'lake',
    name: 'USGS Lakes & Reservoirs',
    color: '#3fa9ff',
    viewport: false,
  }),
  Object.freeze({
    id: 'local-usgs-springs',
    cls: 'spring',
    name: 'USGS Springs',
    color: '#ffd23f',
    viewport: false,
  }),
]);

/** Parse a JSON Lines body into features (blank lines ignored). */
export function parseJsonl(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * The camera view as a degree box, or null when it cannot be expressed as one
 * (looking at space / horizon / across the antimeridian).
 */
export function viewBoxDegrees(viewer) {
  const rect = viewer?.camera?.computeViewRectangle?.(
    viewer.scene?.globe?.ellipsoid,
  );
  if (!rect) return null;
  const box = {
    west: Cesium.Math.toDegrees(rect.west),
    south: Cesium.Math.toDegrees(rect.south),
    east: Cesium.Math.toDegrees(rect.east),
    north: Cesium.Math.toDegrees(rect.north),
  };
  if (!Object.values(box).every(Number.isFinite)) return null;
  if (box.north <= box.south || box.east <= box.west) return null;
  return box;
}

/**
 * Pick the stream tiles for a view box. Pure.
 * @param {object} tiles manifest.classes.stream.tiles: key -> {bounds:[w,s,e,n], file, count}
 * @param {{west:number,south:number,east:number,north:number}|null} box
 * @returns {{status:'ok'|'zoom-in', tiles:Array<{key:string,file:string,count:number}>}}
 */
export function selectStreamTiles(tiles, box) {
  if (!box) return { status: 'zoom-in', tiles: [] };
  if (
    box.east - box.west > STREAM_MAX_VIEW_DEG ||
    box.north - box.south > STREAM_MAX_VIEW_DEG
  )
    return { status: 'zoom-in', tiles: [] };
  const picked = [];
  // Degrees round-trip through radians (Cesium rectangles), so a view that
  // stops exactly on a tile edge comes back a hair inside it. Without a
  // tolerance that sliver fetches a whole neighbouring tile for nothing.
  const EPS = 1e-6;
  for (const [key, tile] of Object.entries(tiles || {})) {
    const [w, s, e, n] = tile.bounds || [];
    if (
      e <= box.west + EPS ||
      w >= box.east - EPS ||
      n <= box.south + EPS ||
      s >= box.north - EPS
    )
      continue;
    picked.push({ key, file: tile.file, count: tile.count });
  }
  picked.sort((a, b) => a.key.localeCompare(b.key));
  if (picked.length > STREAM_MAX_TILES) return { status: 'zoom-in', tiles: [] };
  return { status: 'ok', tiles: picked };
}

async function fetchText(url, signal, fetchImpl) {
  const response = await fetchImpl(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
  return response.text();
}

/**
 * Create the water layers. Each returned layer is a standard local GeoJSON
 * layer; the stream layer additionally reloads on camera settle and reports
 * a 'zoom-in' guidance status when the view is too wide.
 * @param {object} services local GeoJSON services (overlay host, contexts, ...)
 * @param {{fetchImpl?: Function, base?: string}} [options]
 */
export function createUsgsWaterLayers(
  services,
  {
    fetchImpl = (...a) => fetch(...a),
    base = USGS_WATER_BASE,
    screenSpaceEventHandlerFactory,
  } = {},
) {
  return USGS_WATER_LAYERS.map((spec) => {
    let manifest = null;
    let viewStatus = 'ok';
    let tileKeys = '';
    let moveRemover = null;
    let reloadTimer = null;

    async function loadManifest(signal) {
      manifest = JSON.parse(
        await fetchText(`${base}/manifest.json`, signal, fetchImpl),
      );
      return manifest;
    }

    const loadFeatures = async (signal, viewer) => {
      const m = await loadManifest(signal);
      const cls = m?.classes?.[spec.cls];
      if (!cls) throw new Error(`manifest has no ${spec.cls} class`);
      if (!spec.viewport) {
        viewStatus = 'ok';
        return parseJsonl(
          await fetchText(`${base}/${cls.file}`, signal, fetchImpl),
        );
      }
      const pick = selectStreamTiles(cls.tiles, viewBoxDegrees(viewer));
      viewStatus = pick.status;
      tileKeys = pick.tiles.map((t) => t.key).join(',');
      const bodies = await Promise.all(
        pick.tiles.map((t) =>
          fetchText(`${base}/${t.file}`, signal, fetchImpl),
        ),
      );
      return bodies.flatMap(parseJsonl);
    };

    const layer = createLocalGeoJsonLayer(
      {
        id: spec.id,
        url: `${base}/${spec.cls}.geojsonl`,
        name: spec.name,
        color: spec.color,
        icon: '💧',
        source: SOURCE,
        labels: true,
        labelMax: 700,
        labelGridPx: 138,
        loadFeatures,
        ...(screenSpaceEventHandlerFactory
          ? { screenSpaceEventHandlerFactory }
          : {}),
      },
      services,
    );

    const baseEnable = layer.enable;
    const baseDisable = layer.disable;
    const baseDestroy = layer.destroy;
    const baseStats = layer.getStats;

    // Re-fetch the small classes on every enable (no stale in-memory cache).
    layer.enable = async (viewer) => {
      await baseEnable(viewer);
      if (!spec.viewport || moveRemover || !viewer?.camera?.moveEnd) return;
      moveRemover = viewer.camera.moveEnd.addEventListener(() => {
        clearTimeout(reloadTimer);
        // Settle briefly so a fling does not fetch every intermediate view.
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          const cls = manifest?.classes?.[spec.cls];
          const next = selectStreamTiles(cls?.tiles, viewBoxDegrees(viewer));
          const nextKeys = next.tiles.map((t) => t.key).join(',');
          if (next.status === viewStatus && nextKeys === tileKeys) return;
          layer.reload(viewer);
        }, 400);
      });
    };

    const stopTracking = () => {
      clearTimeout(reloadTimer);
      reloadTimer = null;
      if (moveRemover) {
        moveRemover();
        moveRemover = null;
      }
    };
    layer.disable = (viewer) => {
      stopTracking();
      viewStatus = 'ok';
      tileKeys = '';
      return baseDisable(viewer);
    };
    layer.destroy = (viewer) => {
      stopTracking();
      return baseDestroy(viewer);
    };
    layer.getStats = () => {
      const stats = baseStats();
      if (spec.viewport && viewStatus === 'zoom-in' && !stats.error) {
        return {
          ...stats,
          status: 'zoom-in',
          statusMessage: msg('Zoom in to a region to load river gauges'),
        };
      }
      return stats;
    };
    /** Diagnostics for QA/tests: which stream tiles are loaded. */
    layer.getViewportDiagnostics = () => ({
      status: viewStatus,
      tiles: tileKeys ? tileKeys.split(',') : [],
    });
    return layer;
  });
}
