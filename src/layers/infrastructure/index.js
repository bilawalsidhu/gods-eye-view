import { waitForSignal } from '../../sources/requestDeadline.js';
import * as geo from '../../geo/index.js';
import {
  mapAnalystRecord,
  parseGeojsonLines,
} from '../../sources/infrastructureData.js';
import { localDatasetError } from '../../data/localGeojsonCore.js';
import { createInfrastructureDisplay } from './render/display.js';

// Split multipart features as Cesium's GeoJsonDataSource names its entities
// (a repeated id gets `_2`, `_3`, ...), with stable ids on every globe.
function dataset(raw) {
  const features = [],
    records = [],
    used = new Set();
  function part(feature, geometry, key) {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const g of geometry.geometries) part(feature, g, key);
      return;
    }
    if (geometry.type.startsWith('Multi')) {
      for (const coordinates of geometry.coordinates)
        part(feature, { type: geometry.type.slice(5), coordinates }, key);
      return;
    }
    let id = key,
      suffix = 2;
    while (used.has(id)) id = key + '_' + suffix++;
    used.add(id);
    features.push({ ...feature, id, geometry });
    let base;
    if (geometry.type === 'Point')
      base = geo.cartesian3.fromDegrees(...geometry.coordinates);
    if (geometry.type === 'Polygon') {
      const ring = geometry.coordinates[0];
      if (ring.length)
        base = geo.boundingSphere.fromPoints(
          ring.map(([lon, lat, h]) => geo.cartesian3.fromDegrees(lon, lat, h)),
        ).center;
    }
    if (!base) return;
    const pos = geo.cartographic.fromCartesian(base);
    if (pos)
      records.push({
        id,
        lon: geo.math.toDegrees(pos.longitude),
        lat: geo.math.toDegrees(pos.latitude),
        properties: feature.properties ?? {},
        geometry,
      });
  }
  raw.forEach((f, index) =>
    part(
      f,
      f.geometry,
      String(f.id ?? f.properties?.osm_id ?? 'feature-' + index),
    ),
  );
  return { features, records };
}

/**
 * One datacenter or dam layer. The parsed local file and the selected
 * feature outlive any one scene; `createDisplay(engine, config, services)`
 * draws them on each attached engine (show(dataset), select(featureId),
 * hide(), destroy(), lod()), by default the contract display
 * (render/display.js).
 */
export function createInfrastructureSessionLayer(
  config,
  services,
  createDisplay = (engine) =>
    createInfrastructureDisplay(engine, { config, services }),
) {
  const { id, name, icon, source, url } = config;
  let data = null,
    request = null,
    abort = null,
    display = null,
    enabled = false,
    destroyed = false;
  let updated = null,
    error = null,
    selectedId = null;
  const read = () => {
    if (data) return Promise.resolve(data);
    if (!request) {
      const controller = new AbortController();
      abort = controller;
      request = (async () => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw Error('HTTP ' + res.status);
        const raw = parseGeojsonLines(await res.text());
        controller.signal.throwIfAborted();
        data = dataset(raw);
        updated = Date.now();
        error = null;
        return data;
      })().finally(() => {
        if (controller === abort) {
          request = null;
          abort = null;
        }
      });
    }
    return request;
  };
  const show = async () => {
    try {
      const next = await read();
      if (!enabled || destroyed) return;
      const active = display;
      if (active) {
        error = null;
        await active.show(next);
      }
      if (
        active &&
        active === display &&
        enabled &&
        selectedId &&
        !services.getSelectedEntityContext?.()
      )
        active.select(selectedId);
    } catch (cause) {
      if (!destroyed && cause?.name !== 'AbortError')
        error = localDatasetError(cause);
    }
  };
  return {
    id,
    name,
    icon,
    source,
    updateInterval: 0,
    statsRefreshInterval: 1000,
    init(_viewer, options = {}) {
      if (options.engine) return this.attachRenderer(options);
    },
    attachRenderer({ engine = null, signal = null } = {}) {
      if (display) throw Error('Infrastructure display already attached');
      display = engine ? createDisplay(engine, config, services) : null;
      // The dataset load belongs to the session and keeps running; only this
      // scene's wait for it ends when the scene is released. A released
      // display is destroyed and ignores what arrives later.
      if (enabled)
        return waitForSignal(show(), signal).catch((error) => {
          if (!signal?.aborted) throw error;
        });
    },
    detachRenderer() {
      if (!display) return;
      const selected = services.getSelectedEntityContext?.();
      selectedId =
        selected?.layerId === id
          ? String(selected.id).slice(id.length + 1)
          : null;
      display.destroy();
      display = null;
    },
    enable() {
      enabled = true;
      return show();
    },
    disable() {
      enabled = false;
      selectedId = null;
      display?.hide();
    },
    update() {},
    getStats: () => ({
      count: data?.features.length ?? 0,
      lastUpdate: updated,
      error,
    }),
    getLodDiagnostics: () =>
      display?.lod() ?? {
        total: 0,
        active: 0,
        budgetLimit: 0,
        computed: false,
      },
    getAnalystRecords(limit = 2000) {
      if (!enabled || !data) return [];
      return data.records
        .slice(
          0,
          Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 2000,
        )
        .map((r) => mapAnalystRecord(r, id));
    },
    destroy() {
      destroyed = true;
      enabled = false;
      abort?.abort();
      display?.destroy();
      display = data = null;
    },
  };
}
