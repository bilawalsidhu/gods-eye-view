import {
  LOW_RESOURCE_BUDGET as budget,
  PERFORMANCE_STORAGE_KEY,
  readPerformanceMode,
} from './performancePolicy.js';
import { trimStaleSceneCommands } from '../sceneCommandRelease.js';

/** Local resource preferences; all contact data and public layer APIs remain available. */
export function createPerformanceController({
  viewer,
  styleManager,
  dataManager,
  mapStackController,
  store,
  setOverlayPixelRatioCap,
  storage,
  startupRenderBaseline = null,
  initialMode = readPerformanceMode(),
}) {
  let mode = 'standard',
    baseline = null,
    destroyed = false;
  const tileBaselines = new Map();
  let settled = Promise.resolve();
  let removeTrim = null;
  const aircraft = () =>
    ['flights', 'military']
      .map((id) => dataManager.layers.get(id)?.module)
      .filter(Boolean);
  function tuneTiles() {
    if (mode !== 'low' || destroyed) return;
    const visit = (collection) => {
      for (let i = 0; i < collection.length; i++) {
        const p = collection.get(i);
        if (Number.isFinite(p.cacheBytes)) {
          if (!tileBaselines.has(p))
            tileBaselines.set(p, {
              cacheBytes: p.cacheBytes,
              maximumCacheOverflowBytes: p.maximumCacheOverflowBytes,
              maximumScreenSpaceError: p.maximumScreenSpaceError,
            });
          p.cacheBytes = Math.min(p.cacheBytes, budget.tileCacheBytes);
          p.maximumCacheOverflowBytes = Math.min(
            p.maximumCacheOverflowBytes,
            budget.tileOverflowBytes,
          );
          p.maximumScreenSpaceError = Math.max(
            p.maximumScreenSpaceError,
            budget.tileError,
          );
          p.trimLoadedTiles?.();
        } else if (
          typeof p.get === 'function' &&
          Number.isInteger(p.length) &&
          !Number.isFinite(p.renderedCount)
        )
          visit(p);
      }
    };
    visit(viewer.scene.primitives);
  }
  function publish() {
    store.publishPerformance?.({ mode });
  }
  function setMode(next, { persist = true } = {}) {
    if (destroyed || !['low', 'standard'].includes(next)) return false;
    if (next === mode) {
      publish();
      return true;
    }
    if (next === 'low') {
      baseline = {
        fps: viewer.targetFrameRate,
        fleetInterval: viewer.gevFleetIntervalMs,
        resolution: viewer.resolutionScale,
        standardResolution: viewer.gevStandardResolutionScale,
        msaa: viewer.scene.msaaSamples,
        hdr: viewer.scene.highDynamicRange,
        globeTiles: viewer.scene.globe.tileCacheSize,
        globeError: viewer.scene.globe.maximumScreenSpaceError,
        style: styleManager.activeStyle,
        bloom: styleManager.bloomEnabled,
        sharpen: styleManager.sharpenEnabled,
        aircraft: aircraft().map((layer) => ({
          layer,
          params: layer.getParams(),
        })),
      };
      if (startupRenderBaseline) {
        Object.assign(baseline, startupRenderBaseline);
        startupRenderBaseline = null;
      }
      mode = next;
      viewer.targetFrameRate = budget.fps;
      viewer.gevFleetIntervalMs = budget.fleetIntervalMs;
      viewer.gevLowResource = true;
      viewer.resolutionScale = Math.min(
        baseline.resolution,
        budget.resolutionScale,
      );
      viewer.scene.msaaSamples = budget.msaaSamples;
      viewer.scene.highDynamicRange = false;
      viewer.scene.globe.tileCacheSize = Math.min(
        baseline.globeTiles,
        budget.globeTiles,
      );
      viewer.scene.globe.maximumScreenSpaceError = Math.max(
        baseline.globeError,
        budget.globeError,
      );
      setOverlayPixelRatioCap(budget.overlayPixelRatio);
      styleManager.setStyle('normal', {
        applyPreset: false,
        revealParameters: false,
        restore: true,
      });
      styleManager._setBloomEnabled(false);
      styleManager._setSharpenEnabled(false);
      for (const { layer } of baseline.aircraft)
        layer.setParams({ models3d: false });
      tuneTiles();
    } else {
      mode = next;
      viewer.targetFrameRate = baseline.fps;
      if (baseline.fleetInterval === undefined)
        delete viewer.gevFleetIntervalMs;
      else viewer.gevFleetIntervalMs = baseline.fleetInterval;
      viewer.gevLowResource = false;
      viewer.resolutionScale =
        baseline.standardResolution !== undefined &&
        baseline.resolution === baseline.standardResolution
          ? viewer.gevStandardResolutionScale
          : baseline.resolution;
      viewer.scene.msaaSamples = baseline.msaa;
      viewer.scene.highDynamicRange = baseline.hdr;
      viewer.scene.globe.tileCacheSize = baseline.globeTiles;
      viewer.scene.globe.maximumScreenSpaceError = baseline.globeError;
      setOverlayPixelRatioCap(Infinity);
      styleManager.setStyle(baseline.style, {
        applyPreset: false,
        revealParameters: false,
        restore: true,
      });
      styleManager._setBloomEnabled(baseline.bloom);
      styleManager._setSharpenEnabled(baseline.sharpen);
      for (const { layer, params } of baseline.aircraft)
        layer.setParams({
          models3d: params.models3d,
          models3dMode: params.models3dMode,
        });
      for (const [tileset, settings] of tileBaselines)
        if (!tileset.isDestroyed?.()) Object.assign(tileset, settings);
      tileBaselines.clear();
      baseline = null;
    }
    if (persist) {
      try {
        (storage ?? globalThis.localStorage)?.setItem(
          PERFORMANCE_STORAGE_KEY,
          mode,
        );
      } catch {}
    }
    publish();
    if (globalThis.document?.documentElement)
      document.documentElement.dataset.gevPerformance = mode;
    viewer.scene.requestRender();
    settled = settled
      .catch(() => {})
      .then(async () => {
        if (destroyed) return;
        for (const id of ['local-datacenters', 'local-dams'])
          await dataManager.layers
            .get(id)
            ?.module.refreshResourceMode?.(viewer);
        if (
          destroyed ||
          removeTrim ||
          !viewer.scene.postRender?.addEventListener
        )
          return;
        removeTrim = viewer.scene.postRender.addEventListener(() => {
          removeTrim?.();
          removeTrim = null;
          trimStaleSceneCommands(viewer.scene);
        });
        viewer.scene.requestRender();
      });
    void settled.catch(() => {});
    return true;
  }
  const token = store.connect({ setPerformanceMode: (next) => setMode(next) });
  const unsubscribe = mapStackController?.subscribe?.(tuneTiles);
  publish();
  const ready = Promise.resolve(styleManager.initialRestorePromise)
    .catch(() => {})
    .then(() => {
      if (!destroyed) setMode(initialMode, { persist: false });
      return settled;
    });
  return {
    ready,
    whenSettled: () => settled,
    getState: () => ({ mode, budget: mode === 'low' ? budget : null }),
    setMode,
    destroy() {
      destroyed = true;
      removeTrim?.();
      removeTrim = null;
      unsubscribe?.();
      store.detach(token);
      store.publishPerformance?.(null);
      setOverlayPixelRatioCap(Infinity);
      if (globalThis.document?.documentElement)
        delete document.documentElement.dataset.gevPerformance;
      tileBaselines.clear();
    },
  };
}
