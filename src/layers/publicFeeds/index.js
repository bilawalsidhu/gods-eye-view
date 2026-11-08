import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { clearOverlaySource, setOverlayEntries, setOverlaySourceVisible } from '../../overlays/worldOverlay.js';

const AURORA_OVERLAY_SOURCE_ID = 'aurora-forecast';
const DEFAULT_OVERLAY_HOST = {
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
};

const COLORS = { RED: Cesium.Color.RED, ORANGE: Cesium.Color.ORANGE, YELLOW: Cesium.Color.YELLOW, GREEN: Cesium.Color.LIME };

/** Build bounded one-degree grid cells, splitting the antimeridian cell. */
export function auroraRectangles({ lon, lat, probability }) {
  if (probability <= 0) return [];
  const south = Math.max(-90, lat - 0.5), north = Math.min(90, lat + 0.5);
  const west = lon - 0.5, east = lon + 0.5;
  const bounds = west < -180 ? [[west + 360, 180], [-180, east]] : east > 180 ? [[west, 180], [-180, east - 360]] : [[west, east]];
  return bounds.map(([w, e]) => ({ west: w, south, east: e, north, probability }));
}

export function createPublicFeedLayer(kind, { source, overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  if (!['volcanoes', 'aurora'].includes(kind) || typeof source?.getSnapshot !== 'function') throw new TypeError('Public feed requires a snapshot source');
  let data, primitive, request, enabled = false, count = 0, lastUpdate = null, error = null, forecastTime = null;
  return {
    id: kind,
    get name() { return kind === 'volcanoes' ? t('Volcano status') : t('Aurora forecast'); },
    icon: kind === 'volcanoes' ? '🌋' : '✦',
    source: kind === 'volcanoes' ? 'USGS' : 'NOAA SWPC',
    updateInterval: kind === 'volcanoes' ? 300000 : 600000,
    init(viewer) { data = new Cesium.CustomDataSource(kind); data.show = false; viewer.dataSources.add(data); if (kind === 'aurora') overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false); },
    enable() { enabled = true; if (data) data.show = true; if (primitive) primitive.show = true; if (kind === 'aurora') overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, true); },
    disable() { enabled = false; request?.abort(); request = null; if (data) data.show = false; if (primitive) primitive.show = false; if (kind === 'aurora') overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false); },
    async update(viewer) {
      if (!enabled || !data) return false;
      request?.abort();
      const current = new AbortController(); request = current;
      try {
        const snapshot = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled) return false;
        const entities = [];
        let nextPrimitive = null;
        if (kind === 'volcanoes') {
          for (const row of snapshot) entities.push(new Cesium.Entity({
            id: `volcano:${row.id}`, name: row.name,
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
            point: { pixelSize: 9, color: COLORS[row.color.toUpperCase()] || Cesium.Color.LIGHTGRAY, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
            properties: { alertLevel: row.alert, aviationColorCode: row.color, region: row.region, alertDate: row.date },
          }));
          count = snapshot.length;
        } else {
          const instances = [];
          for (const row of snapshot.rows) for (const cell of auroraRectangles(row)) instances.push(new Cesium.GeometryInstance({
            geometry: new Cesium.RectangleGeometry({ rectangle: Cesium.Rectangle.fromDegrees(cell.west, cell.south, cell.east, cell.north), vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.LIME.withAlpha(Math.min(0.8, 0.12 + cell.probability / 150))) },
          }));
          if (instances.length) nextPrimitive = new Cesium.GroundPrimitive({ geometryInstances: instances, appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: false }), asynchronous: true });
          forecastTime = snapshot.forecastTime;
          const [title, ...details] = t('NOAA OVATION forecast: {forecastTime}\nBrighter green = higher probability', { forecastTime }).split('\n');
          overlayHost.setEntries(AURORA_OVERLAY_SOURCE_ID, [{
            id: 'forecast-time',
            position: Cesium.Cartesian3.fromDegrees(0, 75),
            variant: 'card',
            title,
            details,
            accent: '#00ff00',
            interactive: false,
            collisionGroup: 'ambient-card',
            horizonCull: true,
            terrainOcclusion: false,
          }], { cohortLimit: 1, collisionCapacity: 1, moving: false });
          count = snapshot.rows.length;
        }
        if (nextPrimitive) viewer.scene.groundPrimitives.add(nextPrimitive);
        if (primitive) viewer.scene.groundPrimitives.remove(primitive);
        primitive = nextPrimitive;
        data.entities.removeAll();
        for (const entity of entities) data.entities.add(entity);
        lastUpdate = Date.now(); error = null; viewer.scene.requestRender?.(); return true;
      } catch (e) {
        if (current.signal.aborted || request !== current || !enabled) return false;
        error = e?.message || t('Public feed unavailable'); return false;
      } finally { if (request === current) request = null; }
    },
    destroy(viewer) { request?.abort(); request = null; enabled = false; if (kind === 'aurora') { overlayHost.clearSource(AURORA_OVERLAY_SOURCE_ID); overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false); } if (primitive) viewer.scene.groundPrimitives.remove(primitive); primitive = null; if (data) viewer.dataSources.remove(data, true); data = null; count = 0; lastUpdate = null; error = null; forecastTime = null; },
    getStats() { return { count, lastUpdate, error, forecastTime }; },
  };
}
