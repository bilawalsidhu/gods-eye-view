import * as Cesium from 'cesium';
import {
  LOD_LEVELS,
  LOD_HYSTERESIS,
  VIEW_PADDING,
  LOD_CHECK_MS,
} from './policy.js';

export function createViewport({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { governorRequestRender } = services.render;

  /**
   * Ambient labels are placed via screen-space projection, so they need a
   * re-declutter after the camera settles — on moveEnd, never per frame.
   */

  function installMoveEndWatcher() {
    if (layerState._moveEndRemover || !layerState._viewer) return;
    layerState._moveEndRemover =
      layerState._viewer.camera.moveEnd.addEventListener(() => {
        if (!layerState._enabled) return;
        // Settled-camera exactness for the horizon pass (the throttled preRender
        // watcher can last have run up to LOD_CHECK_MS before the camera
        // stopped). Runs ahead of the `_loading` gate on purpose: the sprites on
        // screen during a refresh are the ones that need culling.
        components.rendering.refreshHorizonCulling();
        if (layerState._loading) return;
        components.cards.rebuildAmbientLabels();
      });
  }

  function removeMoveEndWatcher() {
    if (layerState._moveEndRemover) {
      layerState._moveEndRemover();
      layerState._moveEndRemover = null;
    }
  }

  function cameraHeight() {
    return (
      layerState._viewer?.camera?.positionCartographic?.height ??
      Number.POSITIVE_INFINITY
    );
  }

  /** Raw LOD index for a camera height (0 = global ... 3 = close). */

  function rawLodIndex(height) {
    const index = LOD_LEVELS.findIndex((level) => height >= level.minHeight);
    return index === -1 ? LOD_LEVELS.length - 1 : index;
  }

  /**
   * LOD selection with ±10% hysteresis around band floors: a band switch
   * only happens once the camera clears the boundary by the margin, so a
   * slow zoom oscillating on an edge cannot trigger a rebuild every check.
   * @param {number} height - Camera height in meters.
   * @returns {number} LOD index to render.
   */

  function selectLodIndex(height) {
    const raw = rawLodIndex(height);
    if (layerState._currentLodIndex < 0 || raw === layerState._currentLodIndex)
      return raw;
    let index = layerState._currentLodIndex;
    // Zooming out: enter a coarser band only after clearing its floor by +10%.
    while (
      index > raw &&
      height >= LOD_LEVELS[index - 1].minHeight * (1 + LOD_HYSTERESIS)
    )
      index -= 1;
    // Zooming in: leave the current band only after dropping 10% below its floor.
    while (
      index < raw &&
      height <= LOD_LEVELS[index].minHeight * (1 - LOD_HYSTERESIS)
    )
      index += 1;
    return index;
  }

  /** Current camera view rectangle, or null when looking at sky/horizon. */

  function computeViewRect() {
    try {
      const rect = layerState._viewer?.camera?.computeViewRectangle(
        layerState._viewer?.scene?.globe?.ellipsoid,
        layerState.scratchViewRect,
      );
      return rect || null;
    } catch {
      return null;
    }
  }

  /**
   * True when the camera view rectangle drifted far enough from the last
   * rendered one that the padding is at risk of being consumed (pan) or
   * the footprint changed notably (zoom within a band).
   * @param {?Cesium.Rectangle} viewRect - Current view rectangle.
   * @returns {boolean}
   */

  function viewChangedEnough(viewRect) {
    if (!viewRect) return false; // sky/horizon — keep the current render
    if (!layerState._lastViewRect) return true; // previous render was global fallback
    const lastWidth = Cesium.Rectangle.computeWidth(layerState._lastViewRect);
    const lastHeight = Cesium.Rectangle.computeHeight(layerState._lastViewRect);
    const width = Cesium.Rectangle.computeWidth(viewRect);
    const height = Cesium.Rectangle.computeHeight(viewRect);
    if (width > lastWidth * 1.3 || width < lastWidth * 0.75) return true;
    if (height > lastHeight * 1.3 || height < lastHeight * 0.75) return true;
    const lastCenter = Cesium.Rectangle.center(
      layerState._lastViewRect,
      layerState.scratchCenterA,
    );
    const center = Cesium.Rectangle.center(viewRect, layerState.scratchCenterB);
    const latShift = Math.abs(center.latitude - lastCenter.latitude);
    let lonShift = Math.abs(center.longitude - lastCenter.longitude);
    if (lonShift > Math.PI) lonShift = Cesium.Math.TWO_PI - lonShift;
    return (
      latShift > lastHeight * VIEW_PADDING * 0.6 ||
      lonShift > lastWidth * VIEW_PADDING * 0.6
    );
  }

  function installLodWatcher() {
    if (layerState._preRenderRemover || !layerState._viewer) return;
    // The LOD sweep is throttle-gated inside preRender. When the camera
    // settles just inside the throttle window, the final rebuild would wait
    // for a frame that idle mode never produces — schedule one. (perf wave 2)
    if (!layerState._moveEndSettleRemover) {
      layerState._moveEndSettleRemover =
        layerState._viewer.camera.moveEnd.addEventListener(() => {
          if (!layerState._enabled) return;
          setTimeout(
            () => governorRequestRender('firms-lod-settle'),
            LOD_CHECK_MS + 40,
          );
        });
    }
    layerState._preRenderRemover =
      layerState._viewer.scene.preRender.addEventListener(() => {
        // NOTE: `_loading`/empty-data are deliberately NOT part of this guard.
        // A refresh has no timeout, and sprites from the previous payload stay
        // on screen throughout it — so the horizon pass below must keep running
        // while a fetch is in flight. Only the rebuild is gated on fresh data.
        if (!layerState._enabled) return;
        const now = performance.now();
        if (now - layerState._lastLodCheck < LOD_CHECK_MS) return;
        layerState._lastLodCheck = now;
        // Idle camera: two scratch compares and out — no view-rect math, no
        // aggregation, no allocation while the user is parked.
        const camera = layerState._viewer.camera;
        if (
          layerState._camSnapValid &&
          Cesium.Cartesian3.equalsEpsilon(
            camera.positionWC,
            layerState._camPos,
            0,
            0.5,
          ) &&
          Cesium.Cartesian3.equalsEpsilon(
            camera.directionWC,
            layerState._camDir,
            0,
            1e-7,
          )
        ) {
          return;
        }
        Cesium.Cartesian3.clone(camera.positionWC, layerState._camPos);
        Cesium.Cartesian3.clone(camera.directionWC, layerState._camDir);
        layerState._camSnapValid = true;
        // The camera moved, so the horizon moved. A rebuild culls its own fresh
        // sprites (renderDetections); an early-out — same LOD band and view
        // rect, or a refresh in flight — does not, so cull here instead.
        // Exactly ONE occlusion walk per tick either way, bounded by the
        // idle-gate + LOD_CHECK_MS throttle above: a parked camera costs
        // nothing, a moving one pays one ≤maxDetections show-flip walk at
        // ~1.5 Hz.
        const rebuilt =
          layerState._fires.length && !layerState._loading
            ? components.rendering.renderCurrentLod(false)
            : false;
        if (!rebuilt) components.rendering.refreshHorizonCulling();
      });
  }

  function removeLodWatcher() {
    if (layerState._preRenderRemover) {
      layerState._preRenderRemover();
      layerState._preRenderRemover = null;
    }
    if (layerState._moveEndSettleRemover) {
      layerState._moveEndSettleRemover();
      layerState._moveEndSettleRemover = null;
    }
  }
  return {
    installMoveEndWatcher,
    removeMoveEndWatcher,
    cameraHeight,
    rawLodIndex,
    selectLodIndex,
    computeViewRect,
    viewChangedEnough,
    installLodWatcher,
    removeLodWatcher,
  };
}
