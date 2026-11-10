import {
  rectangleCenter,
  rectangleHeight,
  rectangleWidth,
} from '../../geo/rectangle.js';
import { TWO_PI, toRadians } from '../../geo/vector.js';
import { findCamera } from '../../render/rendererOf.js';
import {
  LOD_LEVELS,
  LOD_HYSTERESIS,
  VIEW_PADDING,
  LOD_CHECK_MS,
} from './policy.js';

/** Each component of `a` within `epsilon` of `b`'s. */
const near = (a, b, epsilon) =>
  Math.abs(a.x - b.x) <= epsilon &&
  Math.abs(a.y - b.y) <= epsilon &&
  Math.abs(a.z - b.z) <= epsilon;

export function createViewport({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { governorRequestRender } = services.render;
  const camera = () => findCamera(layerState._viewer);

  /**
   * Ambient labels are placed via screen-space projection, so they need a
   * re-declutter after the camera settles — on moveEnd, never per frame.
   */

  function installMoveEndWatcher() {
    if (layerState._moveEndRemover || !layerState._viewer) return;
    layerState._moveEndRemover =
      camera()?.on('moveEnd', () => {
        if (!layerState._enabled || layerState._loading) return;
        components.cards.rebuildAmbientLabels();
      }) ?? null;
  }

  function removeMoveEndWatcher() {
    if (layerState._moveEndRemover) {
      layerState._moveEndRemover();
      layerState._moveEndRemover = null;
    }
  }

  function cameraHeight() {
    const height = camera()?.pose().height;
    return Number.isFinite(height) ? height : Number.POSITIVE_INFINITY;
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

  /**
   * Current camera view rectangle, radians, or null when looking at
   * sky/horizon.
   */

  function computeViewRect() {
    try {
      const rect = camera()?.viewRectangle();
      if (!rect) return null;
      return {
        west: toRadians(rect.west),
        south: toRadians(rect.south),
        east: toRadians(rect.east),
        north: toRadians(rect.north),
      };
    } catch {
      return null;
    }
  }

  /**
   * True when the camera view rectangle drifted far enough from the last
   * rendered one that the padding is at risk of being consumed (pan) or
   * the footprint changed notably (zoom within a band).
   * @param {?{west: number, south: number, east: number, north: number}} viewRect
   *   Current view rectangle, radians.
   * @returns {boolean}
   */

  function viewChangedEnough(viewRect) {
    if (!viewRect) return false; // sky/horizon — keep the current render
    if (!layerState._lastViewRect) return true; // previous render was global fallback
    const lastWidth = rectangleWidth(layerState._lastViewRect);
    const lastHeight = rectangleHeight(layerState._lastViewRect);
    const width = rectangleWidth(viewRect);
    const height = rectangleHeight(viewRect);
    if (width > lastWidth * 1.3 || width < lastWidth * 0.75) return true;
    if (height > lastHeight * 1.3 || height < lastHeight * 0.75) return true;
    const lastCenter = rectangleCenter(layerState._lastViewRect);
    const center = rectangleCenter(viewRect);
    const latShift = Math.abs(center.lat - lastCenter.lat);
    let lonShift = Math.abs(center.lon - lastCenter.lon);
    if (lonShift > Math.PI) lonShift = TWO_PI - lonShift;
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
        camera()?.on('moveEnd', () => {
          if (!layerState._enabled) return;
          setTimeout(
            () => governorRequestRender('firms-lod-settle'),
            LOD_CHECK_MS + 40,
          );
        }) ?? null;
    }
    const { frame } = components.rendering.scenePorts();
    if (!frame) return;
    layerState._preRenderRemover = frame.on('preRender', () => {
      // NOTE: `_loading`/empty-data are deliberately NOT part of this guard.
      // A refresh has no timeout, and sprites from the previous payload stay
      // on screen throughout it — so the hand-off fade below must keep running
      // while a fetch is in flight. Only the rebuild is gated on fresh data.
      if (!layerState._enabled) return;
      // Every frame, ahead of the throttle: a fast zoom crosses the whole
      // hand-off between two band checks.
      components.rendering.applyHandoffFade();
      const now = performance.now();
      if (now - layerState._lastLodCheck < LOD_CHECK_MS) return;
      layerState._lastLodCheck = now;
      // Idle camera: two compares and out — no view-rect math and no
      // aggregation while the user is parked.
      const pose = camera()?.pose();
      if (!pose) return;
      if (
        layerState._camSnapValid &&
        near(pose.position, layerState._camPos, 0.5) &&
        near(pose.direction, layerState._camDir, 1e-7)
      ) {
        return;
      }
      layerState._camPos = pose.position;
      layerState._camDir = pose.direction;
      layerState._camSnapValid = true;
      if (layerState._fires.length && !layerState._loading)
        components.rendering.renderCurrentLod(false);
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
