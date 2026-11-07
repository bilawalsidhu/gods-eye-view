import {
  trafficStyleProfile,
  presetSizeDelta,
  presetDotRgba,
  presetDotOutline,
} from '../../data/trafficPresetStyle.js';
import * as Cesium from 'cesium';
import {
  SIZE_BY_TYPE,
  STYLED_MIN_BASE_PX,
  FLOW_BUCKET_COLORS,
  JAM_DOT_FAR_SCALE,
  SIM_DOT_COLOR,
} from './policy.js';

export function createStyle({ state: layerState, services, parts, source }) {
  // The dots' renderer colours as the point primitives take them, one per
  // colour, so painting a dot allocates nothing. Keyed by identity: the
  // colours are frozen, and a preset change makes new ones.
  const pointColors = new WeakMap();

  /** A renderer colour (`[r, g, b, a]`) as a point primitive colour. */
  function pointColor(rgba) {
    let color = pointColors.get(rgba);
    if (!color) {
      color = new Cesium.Color(rgba[0], rgba[1], rgba[2], rgba[3]);
      pointColors.set(rgba, color);
    }
    return color;
  }

  /** The point colour of a dot in `bucket` (null: simulated white). */
  function dotColor(bucket) {
    return pointColor(
      bucket ? layerState._activeBucketColors[bucket] : SIM_DOT_COLOR,
    );
  }

  /** Paint a dot's point in its bucket's colour, as a late flow update does. */
  function paintDot(dot, bucket) {
    dot.point.color = dotColor(bucket);
  }

  /** Show or hide a dot's point. */
  function showDot(dot, show) {
    dot.point.show = show;
  }

  /** Keep a prominent jam dot larger at range. */
  function emphasizeJamDot(dot) {
    dot.point.scaleByDistance = new Cesium.NearFarScalar(
      100,
      1.5,
      layerState._fadeScaleFar,
      JAM_DOT_FAR_SCALE,
    );
  }
  /** @returns {boolean} A non-normal preset profile is active and enabled. */

  function presetProfileActive() {
    return (
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) !== 'normal'
    );
  }

  /**
   * Pixel-size delta the active preset adds for a bucket (0 when the kill
   * switch is off or the profile is normal).
   * @param {'free'|'slow'|'jam'|null} bucket - Flow bucket.
   * @returns {number} Pixels to add on top of the shipped sizing.
   */

  function activeSizeDelta(bucket) {
    return layerState._presetDots === 'on'
      ? presetSizeDelta(layerState._stylePreset, bucket)
      : 0;
  }

  /**
   * Base pixel size for a dot: shipped SIZE_BY_TYPE, floored at
   * STYLED_MIN_BASE_PX for colored dots while a styled preset is active.
   * @param {string} roadType - OSM highway class.
   * @param {'free'|'slow'|'jam'|null} bucket - Flow bucket (null = sim).
   * @returns {number} Base pixel size before jam/preset deltas.
   */

  function baseDotSize(roadType, bucket) {
    const base = SIZE_BY_TYPE[roadType] || 4;
    return bucket && presetProfileActive()
      ? Math.max(base, STYLED_MIN_BASE_PX)
      : base;
  }

  /** Recompute `_activeBucketColors` from the active style + kill switch. */

  function refreshBucketColors() {
    for (const bucket of ['free', 'slow', 'jam']) {
      const rgba =
        layerState._presetDots === 'on'
          ? presetDotRgba(layerState._stylePreset, bucket)
          : null;
      layerState._activeBucketColors[bucket] = rgba
        ? Object.freeze([rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3]])
        : FLOW_BUCKET_COLORS[bucket];
    }
  }

  /**
   * Apply the active preset's dark-halo outline to a colored dot (or clear
   * it back to the shipped no-outline state). NVG's auto-gain saturates the
   * scene, so brightness alone cannot separate a dot from a bright road —
   * the dark ring restores local contrast through every luma-mapping shader.
   * @param {Cesium.PointPrimitive} point - The dot primitive.
   * @param {'free'|'slow'|'jam'|null} bucket - Flow bucket (null = sim).
   */

  function applyOutline(point, bucket) {
    const spec =
      layerState._presetDots === 'on'
        ? presetDotOutline(layerState._stylePreset, bucket)
        : null;
    if (spec) {
      point.outlineColor = new Cesium.Color(
        spec.rgba[0] / 255,
        spec.rgba[1] / 255,
        spec.rgba[2] / 255,
        spec.rgba[3],
      );
      point.outlineWidth = spec.width;
    } else {
      point.outlineWidth = 0;
    }
  }

  /**
   * Re-apply dot styling in place after a style/param change: colored dots
   * get the (new) effective bucket color and size; sim (white) dots are
   * never touched. No refetch, no respawn — heat-lines rebuild for their
   * per-preset colors.
   */

  function restyleDotsInPlace() {
    refreshBucketColors();
    if (!layerState._dots.length && !layerState._heatLineCount) return;
    for (const dot of layerState._dots) {
      const bucket = dot.bucket;
      if (!bucket) continue; // sim/uncovered dots stay byte-identical
      dot.point.color = dotColor(bucket);
      dot.nominalSize = dot.point.pixelSize =
        baseDotSize(dot.road?.type, bucket) +
        (bucket === 'jam' ? 1 : 0) +
        activeSizeDelta(bucket);
      applyOutline(dot.point, bucket);
    }
    parts.rendering.rebuildHeatLines(
      parts.rendering.visibleRoadsForAltitude(
        layerState._roads,
        layerState._lastRenderAltitude,
      ),
    );
  }

  /**
   * Adopt a new active style preset (from the gev:style-change event or the
   * dataset read at init) and restyle live dots immediately.
   * @param {string|null|undefined} name - StyleManager preset name.
   */

  function setStylePreset(name) {
    const next = typeof name === 'string' && name ? name : 'normal';
    if (next === layerState._stylePreset) return;
    layerState._stylePreset = next;
    restyleDotsInPlace();
  }

  /** @returns {boolean} Density/queue/creep prototype active. */

  function jamDensityOn() {
    return layerState._jamViz === 'density' || layerState._jamViz === 'both';
  }

  /** @returns {boolean} Heat-line prototype active. */

  function heatlineOn() {
    return layerState._jamViz === 'heatline' || layerState._jamViz === 'both';
  }
  return {
    dotColor,
    paintDot,
    showDot,
    emphasizeJamDot,
    presetProfileActive,
    activeSizeDelta,
    baseDotSize,
    refreshBucketColors,
    applyOutline,
    restyleDotsInPlace,
    setStylePreset,
    jamDensityOn,
    heatlineOn,
  };
}
