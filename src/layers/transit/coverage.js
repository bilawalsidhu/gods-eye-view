import * as Cesium from 'cesium';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';
import { buildTransitCoveragePoints } from '../../data/transitCoverage.js';
import { COVERAGE_PEAK_ALPHA, coverageOpacityAt } from './policy.js';

/** Sprite edge in px; drawn smaller, so the falloff stays smooth. */
const SPRITE_PX = 64;
/**
 * Height of the spots above the ellipsoid, metres. Clear of every mountain
 * the photoreal mesh can raise under them, and still nothing at the heights
 * the glow is shown from. The depth test stays on, so the far side of the
 * globe hides its own spots.
 */
const SPOT_HEIGHT_M = 12_000;

/**
 * A white radial falloff; each billboard tints it with its own colour. Null
 * where there is no canvas to draw on (a headless host), and the glow is
 * then simply absent.
 */
function glowSprite() {
  if (typeof globalThis.document?.createElement !== 'function') return null;
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = SPRITE_PX;
  canvas.height = SPRITE_PX;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  const half = SPRITE_PX / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.7, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return canvas;
}

/**
 * The globe-view coverage glow.
 *
 * Above the altitude gate the layer polls nothing and draws no vehicles, so
 * a person looking at the whole Earth had no way to tell where Transit has
 * anything to show. This draws one soft spot per registered feed, built once
 * from the registry, that fades in as the camera climbs past the height
 * where vehicles stop being legible and fades out again on the way down.
 * Overlapping spots blend, so regions with many networks read hotter. It
 * never polls a feed.
 *
 * Spots are billboards, not draped imagery: the photoreal tiles do not take
 * a draped raster, and a glow that only showed on flat basemaps would be
 * missing in the default map.
 *
 * @param {object} context
 * @returns {object}
 */
export function createCoverage({ state }) {
  function build() {
    const image = glowSprite();
    if (!image || !state._viewer?.scene?.primitives) return null;
    const collection = new Cesium.BillboardCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    for (const point of buildTransitCoveragePoints(TRANSIT_ENABLED_FEEDS)) {
      const [r, g, b] = point.rgb;
      collection.add({
        position: Cesium.Cartesian3.fromDegrees(
          point.lon,
          point.lat,
          SPOT_HEIGHT_M,
        ),
        image,
        width: point.sizePx,
        height: point.sizePx,
        color: Cesium.Color.fromBytes(r, g, b, 0),
      });
    }
    state._viewer.scene.primitives.add(collection);
    return collection;
  }

  function paint(opacity) {
    const collection = state._coverageSpots;
    const alpha = opacity * COVERAGE_PEAK_ALPHA;
    for (let i = 0; i < collection.length; i++) {
      const spot = collection.get(i);
      spot.color = Cesium.Color.clone(spot.color).withAlpha(alpha);
    }
    collection.show = opacity > 0;
  }

  /**
   * Match the glow to the camera. Cheap enough for every camera event: the
   * spots are built on the first call that needs them and never again, and
   * they are restyled only when the quantized opacity moves.
   * @param {number} altitude Camera height above the ellipsoid, metres.
   */
  function sync(altitude) {
    if (!state._enabled || !state._viewer) return;
    const opacity = coverageOpacityAt(altitude);
    if (opacity === state._coverageOpacity) return;
    // Nothing built and nothing to show: do not build for a session that
    // never leaves street level.
    if (opacity === 0 && !state._coverageSpots) {
      state._coverageOpacity = 0;
      return;
    }
    if (!state._coverageSpots) state._coverageSpots = build();
    state._coverageOpacity = opacity;
    if (state._coverageSpots) paint(opacity);
  }

  function hide() {
    state._coverageOpacity = null;
    if (state._coverageSpots) state._coverageSpots.show = false;
  }

  function destroy() {
    state._coverageOpacity = null;
    if (state._coverageSpots) {
      state._viewer?.scene?.primitives?.remove(state._coverageSpots);
      state._coverageSpots = null;
    }
  }

  return { sync, hide, destroy };
}
