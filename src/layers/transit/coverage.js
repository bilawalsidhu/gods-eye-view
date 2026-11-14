import * as Cesium from 'cesium';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';
import { buildTransitCoveragePoints } from '../../data/transitCoverage.js';
import { COVERAGE_PEAK_ALPHA, coverageOpacityAt } from './policy.js';

/** Height of the spots above the ellipsoid, metres: on the surface. */
const SPOT_HEIGHT_M = 0;

/**
 * A Gaussian falloff from the centre of each spot to exactly zero at its
 * rim. No plateau and no edge, so overlapping spots sum into one smooth
 * field instead of showing where each circle ends.
 */
const GLOW_SHADER = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 p = (materialInput.st - 0.5) * 2.0;
  float sigma2 = 2.0 * 0.46 * 0.46;
  float rim = exp(-1.0 / sigma2);
  float glow = clamp((exp(-dot(p, p) / sigma2) - rim) / (1.0 - rim), 0.0, 1.0);
  material.diffuse = color.rgb;
  material.alpha = color.a * glow;
  return material;
}`;

/**
 * The coverage glow.
 *
 * Above the altitude gate the layer polls nothing and draws no vehicles, so
 * a person looking at the whole Earth had no way to tell where Transit has
 * anything to show. This draws one soft spot per feed seen live, built once
 * from the registry: wide spots from orbit, cross-fading into patches the
 * size of each feed's service area as a backdrop under the vehicles at
 * continental and regional zoom, and off close in. Overlapping spots blend,
 * so regions with many networks read hotter. It never polls a feed.
 *
 * Spots are flat discs drawn in the OPAQUE pass with ordinary alpha
 * blending, not billboards and not draped imagery. Translucent billboards
 * go through Cesium's order-independent transparency, whose weights clamp at
 * orbital distances and turn a faint glow into a dark disc with a rim; and
 * the photoreal tiles do not take a draped raster. A disc blended in the
 * opaque pass is drawn over the tiles and the globe alike, under the vehicle
 * markers, and is smooth at any strength.
 *
 * @param {object} context
 * @returns {object}
 */
export function createCoverage({ state }) {
  function batch(points, radiusKm, set) {
    const [r, g, b] = points[0].rgb;
    const material = new Cesium.Material({
      translucent: false,
      fabric: {
        uniforms: { color: Cesium.Color.fromBytes(r, g, b, 0) },
        source: GLOW_SHADER,
      },
    });
    const vertexFormat =
      Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat;
    const primitive = new Cesium.Primitive({
      geometryInstances: points.map(
        (point) =>
          new Cesium.GeometryInstance({
            geometry: new Cesium.EllipseGeometry({
              center: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
              semiMajorAxis: radiusKm(point) * 1000,
              semiMinorAxis: radiusKm(point) * 1000,
              height: SPOT_HEIGHT_M,
              vertexFormat,
            }),
          }),
      ),
      appearance: new Cesium.MaterialAppearance({
        material,
        flat: true,
        translucent: false,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
        renderState: {
          // No depth test: at orbital distances the photoreal mesh is a few
          // coarse facets that bulge kilometres off the ellipsoid, and a
          // disc tested against it comes out speckled. Back-face culling
          // does the hiding instead. A disc lies along the surface, so it
          // faces away from the camera exactly when it is over the horizon.
          depthTest: { enabled: false },
          depthMask: false,
          cull: { enabled: true, face: Cesium.CullFace.BACK },
          blending: Cesium.BlendingState.ALPHA_BLEND,
        },
      }),
      asynchronous: false,
      allowPicking: false,
      show: false,
    });
    state._viewer.scene.primitives.add(primitive);
    // A regional patch is the network's real footprint, and neighbours there
    // overlap far less than the wide orbit spots do, so it is not thinned.
    const strength = set === 'near' ? 1 : points[0].strength;
    return { primitive, material, strength, set };
  }

  function build() {
    if (!state._viewer?.scene?.primitives) return null;
    const buckets = new Map();
    for (const point of buildTransitCoveragePoints(TRANSIT_ENABLED_FEEDS)) {
      if (!buckets.has(point.bucket)) buckets.set(point.bucket, []);
      buckets.get(point.bucket).push(point);
    }
    const batches = [];
    for (const points of buckets.values()) {
      batches.push(batch(points, (point) => point.farRadiusKm, 'far'));
      batches.push(batch(points, (point) => point.nearRadiusKm, 'near'));
    }
    return batches;
  }

  /**
   * Match the glow to the camera. Cheap enough for every camera event: the
   * spots are built on the first call that needs them and never again, and a
   * zoom only moves one colour uniform per batch.
   * @param {number} altitude Camera height above the ellipsoid, metres.
   */
  function sync(altitude) {
    if (!state._enabled || !state._viewer) return;
    const opacity = {
      far: coverageOpacityAt(altitude, 'far'),
      near: coverageOpacityAt(altitude, 'near'),
    };
    const key = `${opacity.far}/${opacity.near}`;
    if (key === state._coverageOpacity) return;
    state._coverageOpacity = key;
    // Nothing built and nothing to show: do not build for a session that
    // never leaves street level.
    if (!state._coverageSpots) {
      if (opacity.far === 0 && opacity.near === 0) return;
      try {
        state._coverageSpots = build();
      } catch (error) {
        // A host that cannot build geometry (headless tests) has no glow.
        state._coverageSpots = [];
        console.warn('[Data:Transit] Coverage glow unavailable:', error);
      }
    }
    for (const entry of state._coverageSpots || []) {
      const value = opacity[entry.set];
      entry.primitive.show = value > 0;
      entry.material.uniforms.color = Cesium.Color.clone(
        entry.material.uniforms.color,
      ).withAlpha(value * COVERAGE_PEAK_ALPHA * entry.strength);
    }
  }

  function hide() {
    state._coverageOpacity = null;
    for (const entry of state._coverageSpots || [])
      entry.primitive.show = false;
  }

  function destroy() {
    state._coverageOpacity = null;
    for (const entry of state._coverageSpots || []) {
      state._viewer?.scene?.primitives?.remove(entry.primitive);
    }
    state._coverageSpots = null;
  }

  return { sync, hide, destroy };
}
