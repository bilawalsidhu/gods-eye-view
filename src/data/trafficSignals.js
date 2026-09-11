import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { deriveFetchCenter } from './trafficBounds.js';
import { registerPickOwner, unregisterPickOwner, resolvePickId } from './pickRegistry.js';
import { SIGNAL_LIMIT, signalBounds, signalQuery, parseSignalLocations, parseSignalSnapshot, signalPresentation } from './trafficSignalsModel.js';

const COLORS = Object.fromEntries(Object.entries({ red: '#ff5454', yellow: '#ffd65c', green: '#54ee98',
  'red-yellow': '#ff9354', 'flashing-green': '#54ee98', 'flashing-yellow': '#ffd65c', off: '#657080', unknown: '#a6b3c5' })
  .map(([key, value]) => [key, Cesium.Color.fromCssColorString(value)]));
const LIMIT_ALTITUDE = 8000;

export function createTrafficSignalsLayer() {
  let viewer, points, handler, panel, detail, status;
  let enabled = false, generation = 0, controller, removeCamera, timer, pollTimer, frame;
  let boxes = [], boundsKey = '', locations = [], records = new Map(), snapshots = [];
  let selected = null, configured = false, loading = false, mapError = null, timingError = null, lastUpdate = null, truncated = false;
  let polling = false, mapLoaded = false, nextMapAttempt = 0;
  let lastPaint = 0;
  let feedMessage = '', pollAfterMs = 1000;
  let mapTruncated = false;

  function paint() {
    const now = performance.now();
    let live = 0, reported = 0;
    for (const record of records.values()) {
      const presentation = signalPresentation(record.timing, record.snapshot, now);
      record.presentation = presentation;
      record.point.color = COLORS[presentation.state];
      if (presentation.state !== 'unknown') {
        if (presentation.observationOnly) reported++;
        else live++;
      }
    }
    if (status) status.textContent = !boxes.length ? 'Zoom below 8 km to load mapped traffic lights'
      : loading ? 'Loading mapped traffic lights…'
        : `${records.size} lights · ${live} with fresh state${reported ? ` · ${reported} recent reports` : ''}${truncated ? ' · display limit reached' : ''} · ${mapError || timingError
          || feedMessage || (configured ? 'Checking live coverage…' : 'Locations only; live timing unavailable')}`;
    const record = records.get(selected);
    if (detail) detail.textContent = record
      ? `${record.name} · ${record.movement}\n${record.presentation.observationOnly && record.presentation.state !== 'unknown' ? 'LAST REPORTED ' : ''}${record.presentation.state.toUpperCase()} · ${record.presentation.countdown}\nSource: ${record.source}\n${record.lat.toFixed(6)}, ${record.lon.toFixed(6)} · WGS84`
      : 'Select a light to inspect it. Gray = unknown state. Map coverage may be incomplete.';
    governorRequestRender('traffic-signals');
  }

  function rebuild() {
    const previous = records;
    const nextRecords = new Map();
    const combined = new Map();
    for (const snapshot of snapshots) {
      for (const signal of snapshot.signals.values()) combined.set(signal.id, { ...signal, timing: signal, snapshot });
    }
    for (const location of locations) if (!combined.has(location.id)) combined.set(location.id, location);
    truncated = mapTruncated || combined.size > SIGNAL_LIMIT || snapshots.some((s) => s.truncated);
    for (const signal of [...combined.values()].slice(0, SIGNAL_LIMIT)) {
      const prior = previous.get(signal.id);
      let point = prior?.point;
      if (!prior || prior.lat !== signal.lat || prior.lon !== signal.lon) {
        if (point) points.remove(point);
        const cartographic = Cesium.Cartographic.fromDegrees(signal.lon, signal.lat);
        let height = viewer.scene.globe?.getHeight(cartographic) || 0;
        if (viewer.scene.sampleHeightSupported) {
          try { height = viewer.scene.sampleHeight(cartographic) ?? height; } catch { /* terrain fallback */ }
        }
        point = points.add({ id: `traffic-signal:${signal.id}`,
          position: Cesium.Cartesian3.fromDegrees(signal.lon, signal.lat, height + 3),
          color: COLORS.unknown, pixelSize: 10, outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
          disableDepthTestDistance: 10000 });
      }
      nextRecords.set(signal.id, { ...signal, point });
    }
    for (const [id, record] of previous) if (!nextRecords.has(id)) points.remove(record.point);
    records = nextRecords;
    if (!records.has(selected)) selected = null;
    paint();
  }

  async function loadMap(epoch, signal) {
    loading = true;
    paint();
    try {
      const response = await fetch('/api/overpass', { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: signalQuery(boxes) }).toString() });
      if (!response.ok) throw new Error('Mapped traffic lights unavailable');
      const result = parseSignalLocations(await response.json());
      if (!enabled || epoch !== generation) return;
      locations = result.signals;
      mapTruncated = result.truncated;
      mapLoaded = true;
      mapError = null;
      lastUpdate = Date.now();
      rebuild();
    } catch (e) {
      if (enabled && epoch === generation && !signal.aborted) mapError = 'Mapped traffic lights unavailable; retrying';
    } finally {
      if (epoch === generation) { loading = false; nextMapAttempt = performance.now() + 30000; paint(); }
    }
  }

  async function poll() {
    if (!enabled || !boxes.length || polling) return;
    const epoch = generation;
    const signal = controller.signal;
    polling = true;
    try {
      if (!configured) {
        const response = await fetch('/api/traffic-signals/status', { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), cache: 'no-store' });
        if (!response.ok) throw new Error('Timing service unavailable');
        const service = await response.json();
        if (!enabled || epoch !== generation) return;
        configured = service.configured === true;
        timingError = null;
        if (!configured) return;
      }
      const next = await Promise.all(boxes.map(async (box) => {
        const start = performance.now();
        const response = await fetch(`/api/traffic-signals/snapshot?${new URLSearchParams(box)}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), cache: 'no-store',
        });
        if (!response.ok) throw new Error('Live timing unavailable');
        const payload = await response.json();
        return parseSignalSnapshot(payload, start, performance.now());
      }));
      if (!enabled || epoch !== generation) return;
      snapshots = next;
      feedMessage = [...new Set(next.map((s) => s.coverage).filter(Boolean))].join(' · ') || 'Live feed connected; coverage varies';
      pollAfterMs = Math.min(...next.map((s) => s.pollAfterMs));
      timingError = null;
      lastUpdate = Date.now();
      rebuild();
    } catch {
      if (enabled && epoch === generation && !signal.aborted) {
        snapshots = [];
        timingError = 'Live timing unavailable';
        rebuild();
      }
    } finally {
      if (epoch === generation) {
        polling = false;
        paint();
        clearTimeout(pollTimer);
        if (enabled) pollTimer = setTimeout(poll, configured ? pollAfterMs : 30000);
      }
    }
  }

  function checkView() {
    if (!enabled) return;
    const camera = viewer.camera;
    let nextBoxes = [];
    if (camera.positionCartographic.height <= LIMIT_ALTITUDE) {
      const canvas = viewer.scene.canvas;
      const hit = camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
      const ground = hit ? Cesium.Cartographic.fromCartesian(hit) : null;
      const center = deriveFetchCenter({ nadirLat: Cesium.Math.toDegrees(camera.positionCartographic.latitude),
        nadirLon: Cesium.Math.toDegrees(camera.positionCartographic.longitude),
        hitLat: ground ? Cesium.Math.toDegrees(ground.latitude) : undefined,
        hitLon: ground ? Cesium.Math.toDegrees(ground.longitude) : undefined });
      nextBoxes = signalBounds(Math.round(center.lat * 1000) / 1000, Math.round(center.lon * 1000) / 1000);
    }
    const key = JSON.stringify(nextBoxes);
    if (key === boundsKey) {
      if (boxes.length && !mapLoaded && !loading && performance.now() >= nextMapAttempt) void loadMap(generation, controller.signal);
      return;
    }
    generation++;
    controller?.abort();
    controller = new AbortController();
    clearTimeout(pollTimer);
    polling = false;
    loading = false;
    mapLoaded = false;
    boundsKey = key;
    boxes = nextBoxes;
    locations = [];
    snapshots = [];
    selected = null;
    mapError = null;
    timingError = null;
    feedMessage = '';
    pollAfterMs = 1000;
    truncated = false;
    mapTruncated = false;
    rebuild();
    if (boxes.length) { void loadMap(generation, controller.signal); void poll(); }
  }

  return {
    id: 'traffic-signals', name: 'Traffic Lights', icon: '🚦', source: 'OpenStreetMap + regional signal feeds', updateInterval: 0,
    init(v) {
      viewer = v;
      points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      points.show = false;
      panel = document.createElement('section');
      panel.className = 'traffic-signals-panel';
      panel.hidden = true;
      panel.setAttribute('aria-label', 'Traffic lights');
      const heading = document.createElement('strong');
      heading.textContent = 'TRAFFIC LIGHTS';
      status = document.createElement('p');
      detail = document.createElement('p');
      panel.append(heading, status, detail);
      document.body.append(panel);
    },
    enable() {
      if (enabled) return;
      enabled = true;
      boundsKey = '';
      points.show = true;
      panel.hidden = false;
      registerPickOwner('traffic-signals', (id) => id.startsWith('traffic-signal:'));
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction(({ position }) => {
        const id = resolvePickId(viewer.scene.pick(position));
        if (id?.startsWith('traffic-signal:')) { selected = id.slice('traffic-signal:'.length); paint(); }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      removeCamera = viewer.camera.moveEnd.addEventListener(checkView);
      timer = setInterval(checkView, 1500);
      const tick = (now) => {
        if (!enabled) return;
        // Decimal countdown follows display frames; state/expiry checks run at
        // least every 100 ms in the foreground, without a fake 1 kHz render loop.
        if (snapshots.some((s) => s.signals.size > 0) && (selected || now - lastPaint >= 100)) { lastPaint = now; paint(); }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      checkView();
    },
    disable() {
      enabled = false;
      generation++;
      controller?.abort();
      clearInterval(timer);
      clearTimeout(pollTimer);
      cancelAnimationFrame(frame);
      removeCamera?.();
      handler?.destroy();
      handler = null;
      unregisterPickOwner('traffic-signals');
      records.clear();
      snapshots = [];
      locations = [];
      selected = null;
      polling = false;
      loading = false;
      points.removeAll();
      points.show = false;
      panel.hidden = true;
      governorRequestRender('traffic-signals-disable');
    },
    async update() {},
    getStats() {
      return { count: records.size, lastUpdate, loading, error: mapError || timingError, status: boxes.length ? 'ready' : 'zoom-in',
        loadingLabel: !boxes.length ? 'Zoom below 8 km' : feedMessage || (configured ? 'Checking regional live coverage' : 'Locations only; timing unavailable'),
        coverage: 'Mapped locations in a local area; incomplete coverage', truncated };
    },
    destroy() { this.disable(); viewer.scene.primitives.remove(points); panel.remove(); },
  };
}

export default createTrafficSignalsLayer();
