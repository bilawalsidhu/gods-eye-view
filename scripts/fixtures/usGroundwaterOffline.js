import * as Cesium from 'cesium';
import sample from '../../fixtures/us-groundwater/v1/expected-pack.json' with { type: 'json' };
import { createUsGroundwaterLayer } from '../../src/layers/usGroundwater/index.js';
import * as overlays from '../../src/overlays/worldOverlay.js';
import { initTrackedReadout } from '../../src/data/trackedReadout.js';
import { getSelectedEntityContext } from '../../src/data/contextStore.js';
import '../../src/ui/styles/foundation.css';

const imagery = await Cesium.TileMapServiceImageryProvider.fromUrl(
  '/cesium/Assets/Textures/NaturalEarthII/',
);
const viewer = new Cesium.Viewer('map', {
  baseLayer: new Cesium.ImageryLayer(imagery),
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  baseLayerPicker: false,
  geocoder: false,
  animation: false,
  timeline: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  skyBox: false,
  skyAtmosphere: false,
});
viewer.scene.globe.enableLighting = false;
const renderErrors = [];
let frames = 0;
let stableFrames = 0,
  previousPose;
let cameraEnded = false;
viewer.camera.moveStart.addEventListener(() => {
  cameraEnded = false;
});
viewer.camera.moveEnd.addEventListener(() => {
  cameraEnded = true;
});
viewer.scene.postRender.addEventListener(() => {
  frames++;
  const c = viewer.camera;
  const pose = JSON.stringify([c.positionWC, c.directionWC, c.upWC]);
  stableFrames = pose === previousPose ? stableFrames + 1 : 0;
  previousPose = pose;
});
viewer.scene.renderError.addEventListener((_scene, error) =>
  renderErrors.push(error.message),
);
overlays.initWorldOverlay(viewer);
initTrackedReadout(viewer);
let layer,
  selected,
  mode = 'sample',
  active = true;
const requests = [];
const detail = structuredClone(sample);
detail.catalogTotal = 6;
detail.coverage.indexed = true;
detail.coverage.description =
  'Offline six-site historical fixture; partial coverage';
const records = sample.records;
const bounds = [
  Math.min(...records.map((r) => r.longitude)),
  Math.min(...records.map((r) => r.latitude)),
  Math.max(...records.map((r) => r.longitude)),
  Math.max(...records.map((r) => r.latitude)),
];
const center = [
  records.reduce((n, r) => n + r.longitude, 0) / 6,
  records.reduce((n, r) => n + r.latitude, 0) / 6,
];
const grid = new Map();
for (const r of records) {
  const west = Math.floor((r.longitude + 180) / 8) * 8 - 180;
  const south = Math.floor((r.latitude + 90) / 8) * 8 - 90;
  const key = `${west}:${south}`;
  const cell = grid.get(key) ?? {
    bounds: [west, south, west + 8, south + 8],
    count: 0,
    center: [0, 0],
  };
  cell.count++;
  cell.center[0] += r.longitude;
  cell.center[1] += r.latitude;
  grid.set(key, cell);
}
const cells = [...grid.values()].map((c) => ({
  ...c,
  center: c.center.map((x) => x / c.count),
}));
const groupCenter = cells.find((c) => c.count === 2).center;
const aggregate = {
  schemaVersion: 1,
  kind: 'gev-well-count-view',
  total: 6,
  degrees: 8,
  centerMethod: 'record-mean',
  coverageComplete: false,
  reason: 'offline six-site group fixture',
  cells,
};
function install(nextMode) {
  layer?.destroy();
  selected = null;
  mode = nextMode;
  active = true;
  requests.length = 0;
  layer = createUsGroundwaterLayer({
    overlays,
    source: {
      viewport: true,
      getSnapshot(options) {
        requests.push({ options });
        if (mode === 'delayed' && requests.length > 1)
          return new Promise((resolve) => {
            requests.at(-1).resolve = resolve;
          });
        if (mode === 'aggregate') return Promise.resolve(aggregate);
        return Promise.resolve(structuredClone(detail));
      },
    },
    onSelect(value) {
      selected = value;
    },
    onStatus(stats) {
      document.querySelector('#stats').textContent = JSON.stringify({
        catalog: stats.count,
        represented: stats.representedLocationCount,
        loading: stats.loading,
        groups: stats.screenGroups,
      });
    },
  });
  layer.init(viewer);
  return layer.enable();
}
function camera(lon, lat, height) {
  stableFrames = 0;
  cameraEnded = false;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}
camera(center[0], center[1], 8000000);
await install('aggregate');
document.querySelector('#toggle').onclick = async () => {
  if (active) layer.disable();
  else await layer.enable();
  active = !active;
};
window.qa = {
  Cesium,
  viewer,
  records,
  bounds,
  center,
  groupCenter,
  detail,
  install,
  camera,
  requests,
  renderErrors,
  settled: () =>
    cameraEnded &&
    stableFrames >= 2 &&
    !viewer.camera._currentFlight &&
    !layer.getStats().loading,
  overlayDiagnostics: () => overlays.getWorldOverlayDiagnostics(),
  diagnostics() {
    const surface = viewer.scene.globe._surface;
    return {
      frames,
      stableFrames,
      cameraEnded,
      selected: selected?.id ?? null,
      contextLayer: getSelectedEntityContext()?.layerId ?? null,
      visibility: document.visibilityState,
      focus: document.hasFocus(),
      canvas: [viewer.canvas.clientWidth, viewer.canvas.clientHeight],
      requestRenderMode: viewer.scene.requestRenderMode,
      globe: {
        tilesLoaded: viewer.scene.globe.tilesLoaded,
        rendered: surface._tilesToRender.length,
        queues: [
          surface._tileLoadQueueHigh.length,
          surface._tileLoadQueueMedium.length,
          surface._tileLoadQueueLow.length,
        ],
        roots: surface._levelZeroTiles?.map((t) => ({
          state: t.state,
          renderable: t.renderable,
          terrainState: t.data?.terrainState,
        })),
      },
      overlays: overlays.getWorldOverlayDiagnostics(),
      overlayDom: ['world-overlay-root', 'world-overlay-canvas'].map((id) => {
        const el = document.getElementById(id);
        const r = el?.getBoundingClientRect();
        return {
          id,
          rect: r && { x: r.x, y: r.y, w: r.width, h: r.height },
          display: el && getComputedStyle(el).display,
        };
      }),
    };
  },
  get layer() {
    return layer;
  },
  get selected() {
    return selected;
  },
  get context() {
    return getSelectedEntityContext();
  },
  setMode(value) {
    mode = value;
  },
  finish(index, pack = detail) {
    requests[index].resolve?.(structuredClone(pack));
  },
  point(lon, lat) {
    const p = Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      Cesium.Cartesian3.fromDegrees(lon, lat),
    );
    return p && { x: p.x, y: p.y };
  },
  pick(x, y) {
    const p = viewer.scene.pick(new Cesium.Cartesian2(x, y));
    return Boolean(p?.id);
  },
  flag() {
    const ds = viewer.dataSources.get(0);
    for (const e of ds?.entities.values ?? []) {
      const r = overlays.getOverlayPaintRect('us-groundwater-counts', e.id);
      if (r) return { ...r, id: e.id };
    }
    return null;
  },
};
