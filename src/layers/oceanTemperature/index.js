import * as Cesium from 'cesium';
import { createOceanSource, NINO34, tileAt, pixelToValue } from './source.js';
import { createOceanRendering } from './rendering.js';
import { oceanControls } from './controls.js';
import { msg, t } from '../../i18n/index.js';

export function createOceanTemperatureLayer({
  source = createOceanSource(),
  input = null,
  overlayHost = null,
  cesium = Cesium,
  createRendering = createOceanRendering,
  document = globalThis.document,
} = {}) {
  let viewer = null;
  let rendering = null;
  let imageryHost = null;
  let listener = null;
  let lease = null;
  let handler = null;
  let enabled = false;
  let loading = false;
  let mode = 'anomaly';
  let date = null;
  let followingLatest = true;
  let metadata = null;
  let palette = [];
  let error = null;
  let reading = null;
  let showNino34 = false;
  let region = null;
  let generation = 0;
  let sampleGeneration = 0;
  const notify = () => listener?.();
  function disarm() {
    if (lease) input.releasePointer(lease);
    lease = null;
  }
  function clearRegion() {
    if (region) viewer.entities.remove(region);
    overlayHost?.clearSource('ocean-temperature');
    overlayHost?.setVisible('ocean-temperature', false);
    region = null;
  }
  function drawRegion() {
    clearRegion();
    if (!enabled || !showNino34) return;
    region = viewer.entities.add({
      polyline: {
        positions: cesium.Cartesian3.fromDegreesArray(NINO34.flat()),
        width: 2,
        arcType: cesium.ArcType.RHUMB,
        material: cesium.Color.YELLOW,
        clampToGround: false,
      },
    });
    overlayHost?.setEntries('ocean-temperature', [
      {
        id: 'nino34',
        position: cesium.Cartesian3.fromDegrees(-145, 6),
        variant: 'label',
        title: t('Niño 3.4 region'),
        accent: '#ffff00',
        priority: 1000,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        placement: 'above',
      },
    ]);
    overlayHost?.setVisible('ocean-temperature', true);
  }
  async function samplePoint(point) {
    if (
      !enabled ||
      loading ||
      !date ||
      !Number.isFinite(point?.lon) ||
      !Number.isFinite(point?.lat) ||
      Math.abs(point.lat) > 90
    )
      return false;
    const current = ++sampleGeneration;
    const sampledDate = date;
    const sampledMode = mode;
    reading = null;
    notify();
    if (Math.abs(point.lat) > 85.0511287798066) {
      reading = { ...point, value: null };
      notify();
      return true;
    }
    try {
      const maximum = Number(metadata[mode].matrixSet.match(/Level(\d+)$/)[1]);
      const tile = tileAt(point.lon, point.lat, maximum);
      const url = await source.tileUrl(mode, date, {
        z: maximum,
        x: tile.x,
        y: tile.y,
      });
      const image = await new cesium.Resource({ url }).fetchImage({
        preferImageBitmap: true,
      });
      if (
        current !== sampleGeneration ||
        !enabled ||
        date !== sampledDate ||
        mode !== sampledMode
      )
        return false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      reading = {
        ...point,
        value: pixelToValue(
          palette,
          context.getImageData(tile.pixelX, tile.pixelY, 1, 1).data,
        ),
      };
      error = null;
      notify();
      return true;
    } catch (cause) {
      if (current === sampleGeneration && enabled) {
        error = msg('Ocean reading unavailable');
        notify();
      }
      return false;
    }
  }
  const escape = (event) => {
    if (event.key === 'Escape') {
      disarm();
      notify();
    }
  };
  const layer = {
    id: 'ocean-temperature',
    name: 'Ocean Temperature',
    icon: '◒',
    source: 'JPL MUR25 · NASA GIBS',
    updateInterval: 3600000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        cesium,
        document,
        getViewer: () => viewer,
        getHost: () =>
          imageryHost?.() ?? {
            kind: 'globe',
            collection: viewer.imageryLayers,
          },
        onChange: notify,
      });
      if (cesium.ScreenSpaceEventHandler && viewer.scene?.canvas) {
        handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
          if (!lease || !input?.isLeaseCurrent(lease)) return;
          const world = viewer.camera.pickEllipsoid(
            click.position,
            cesium.Ellipsoid.WGS84,
          );
          if (!world) return;
          const point = cesium.Cartographic.fromCartesian(world);
          void samplePoint({
            lon: cesium.Math.toDegrees(point.longitude),
            lat: cesium.Math.toDegrees(point.latitude),
          });
          setTimeout(() => {
            disarm();
            notify();
          }, 0);
        }, cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      document?.addEventListener('keydown', escape);
    },
    attachShellServices(services) {
      disarm();
      imageryHost = services?.imageryHost ?? null;
      rendering?.rehome();
    },
    enable() {
      enabled = true;
      drawRegion();
    },
    disable() {
      enabled = false;
      generation++;
      sampleGeneration++;
      loading = false;
      reading = null;
      error = null;
      disarm();
      clearRegion();
      rendering?.clear();
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      const current = ++generation;
      sampleGeneration++;
      reading = null;
      loading = true;
      notify();
      try {
        const next = await source.metadata();
        if (!enabled || current !== generation || signal?.aborted) return false;
        metadata = next;
        const product = metadata[mode];
        const nextDate = followingLatest
          ? product.latest
          : product.dates.includes(date)
            ? date
            : (product.dates.filter((value) => !date || value <= date).at(-1) ??
              product.dates[0]);
        if (!nextDate) throw new Error('No ocean observations');
        const nextPalette = await source.palette(mode);
        if (!enabled || current !== generation || signal?.aborted) return false;
        date = nextDate;
        palette = nextPalette;
        error = null;
        await rendering?.setField(product, date);
        return true;
      } catch (cause) {
        if (!enabled || current !== generation || signal?.aborted) return false;
        rendering?.clear();
        error = msg('Ocean temperature unavailable');
        return true;
      } finally {
        if (current === generation) {
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      let refresh = false;
      if (['sst', 'anomaly'].includes(params.mode) && mode !== params.mode) {
        mode = params.mode;
        refresh = true;
      }
      if (params.latest === true) {
        followingLatest = true;
        date = null;
        refresh = true;
      }
      const dates = metadata?.[mode]?.dates ?? [];
      if (
        typeof params.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(params.date) &&
        (!metadata || dates.includes(params.date))
      ) {
        followingLatest = false;
        date = params.date;
        refresh = true;
      }
      if ([-1, 1].includes(params.step) && dates.includes(date)) {
        const next = dates[dates.indexOf(date) + params.step];
        if (next) {
          followingLatest = false;
          date = next;
          refresh = true;
        }
      }
      if (typeof params.showNino34 === 'boolean') {
        showNino34 = params.showNino34;
        if (viewer) drawRegion();
      }
      if (params.inspect === false) {
        sampleGeneration++;
        reading = null;
        disarm();
      }
      if (typeof params.pick === 'boolean') {
        disarm();
        if (params.pick && enabled && !loading && date)
          lease = input?.claimPointer('ocean-temperature') ?? null;
      }
      if (params.point) void samplePoint(params.point);
      if (refresh && enabled) {
        palette = [];
        disarm();
        rendering?.clear();
        void layer.update(viewer);
      }
      notify();
    },
    getParams: () => ({ mode, date, showNino34 }),
    getPanelControls: () =>
      oceanControls({
        mode,
        date,
        dates: metadata?.[mode]?.dates ?? [],
        palette,
        loading,
        error: error || rendering?.getDiagnostics().imageryError,
        reading,
        armed: Boolean(lease),
        showNino34,
      }),
    getRowControls() {
      return this.getPanelControls();
    },
    setRowControlsListener(next) {
      listener = typeof next === 'function' ? next : null;
    },
    getStats: () => ({
      count: 0,
      countLabel: t('Daily analysis'),
      loading,
      lastUpdate: date ? Date.parse(date) : null,
      error: error || rendering?.getDiagnostics().imageryError || null,
      source: 'JPL MUR25 · NASA GIBS',
    }),
    getDiagnostics: () => rendering?.getDiagnostics() ?? {},
    destroy() {
      layer.disable();
      handler?.destroy();
      document?.removeEventListener('keydown', escape);
      rendering?.destroy();
      viewer = rendering = listener = null;
    },
  };
  return layer;
}
