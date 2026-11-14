import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  CYBER_SONAR_RENDER_INTERVAL_MS,
  createCyberSonarSampler,
  isCyberContactSonarActive as isCyberSonarActive,
} from '../../cyberSonar.js';
import {
  formatAwarenessLabel,
  formatAwarenessDistance,
  AWARENESS_RADIUS_M,
} from '../../data/militaryAwarenessEngine.js';
import { bearingBetweenCoordinates } from '../../cockpitMath.js';
import {
  AWARENESS_PAGE_SIZE,
  AWARENESS_RANGE_ECHO,
  AWARENESS_RANGE_PULSE,
  AWARENESS_RANGE_RING_STYLE,
  CONTEXT_RIM_HEIGHT_M,
} from './policy.js';
import { formatAwarenessDirection } from './presentation.js';
import {
  awarenessEchoStrength,
  clearAwarenessEchoField,
  setAwarenessEchoField,
} from '../../awarenessEcho.js';

/**
 * A closed ring of positions `radiusM` along the surface from `groundCenter`,
 * raised to `heightM`. Each bearing steps over a sphere with the ellipsoid's
 * radius of curvature in that direction (Euler's formula), which keeps the
 * ring within ~50 m of the true geodesic radius at 250 km.
 * @param {Cesium.Cartesian3} groundCenter Ring centre on the ellipsoid.
 * @param {number} radiusM Surface radius in metres.
 * @param {number} heightM Height of the ring above the ellipsoid.
 * @param {number} [segments] Chords around the ring.
 * @returns {Cesium.Cartesian3[]} `segments + 1` positions; the last repeats the first.
 */
export function awarenessRangeRingPositions(
  groundCenter,
  radiusM,
  heightM,
  segments = AWARENESS_RANGE_RING_STYLE.segments,
) {
  const { latitude, longitude } =
    Cesium.Cartographic.fromCartesian(groundCenter);
  const { x: a, z: b } = Cesium.Ellipsoid.WGS84.radii;
  const e2 = 1 - (b * b) / (a * a);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const w = 1 - e2 * sinLat * sinLat;
  const meridional = (a * (1 - e2)) / (w * Math.sqrt(w));
  const primeVertical = a / Math.sqrt(w);
  // Step along the great circle in 3D from the centre's up, north and east
  // unit vectors. Unlike the latitude/longitude destination formula, this
  // stays well conditioned at and next to the poles.
  const up = [cosLat * cosLon, cosLat * sinLon, sinLat];
  const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
  const east = [-sinLon, cosLon, 0];
  const positions = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = ((i % segments) / segments) * Cesium.Math.TWO_PI;
    const cosB = Math.cos(bearing);
    const sinB = Math.sin(bearing);
    const angular =
      radiusM * ((cosB * cosB) / meridional + (sinB * sinB) / primeVertical);
    const cosA = Math.cos(angular);
    const sinA = Math.sin(angular);
    const [x, y, z] = up.map(
      (u, k) => u * cosA + (north[k] * cosB + east[k] * sinB) * sinA,
    );
    const lat = Math.atan2(z, Math.hypot(x, y));
    const lon = Math.atan2(y, x);
    positions.push(Cesium.Cartesian3.fromRadians(lon, lat, heightM));
  }
  return positions;
}

/**
 * Where pulse `index` is at `nowMs`: its radius and opacity. Pulses travel at
 * constant speed from `startFraction` of the range to the full range, fade in
 * over `fadeInFraction` of the way, then fade as (1 - travel) to the
 * `fadeOutPower` down to `endOpacityFraction` of the peak, so each is dim
 * but still visible when it reaches the range ring. The opacity already
 * includes `peakOpacity`.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {number} index Pulse number, 0 to `count - 1`.
 * @param {number} [radiusM] Range the pulses grow to.
 * @param {object} [pulse] Timing and shape, see `AWARENESS_RANGE_PULSE`.
 * @returns {{radiusM: number, alpha: number}}
 */
export function awarenessPulseState(
  nowMs,
  index,
  radiusM = AWARENESS_RADIUS_M,
  pulse = AWARENESS_RANGE_PULSE,
) {
  const cycle = nowMs / pulse.periodMs + index / pulse.count;
  const phase = cycle - Math.floor(cycle);
  return {
    radiusM:
      radiusM * (pulse.startFraction + (1 - pulse.startFraction) * phase),
    alpha:
      pulse.peakOpacity *
      Math.min(1, phase / pulse.fadeInFraction) *
      (pulse.endOpacityFraction +
        (1 - pulse.endOpacityFraction) * (1 - phase) ** pulse.fadeOutPower),
  };
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Whether the viewer asked the system for less motion. */
function prefersReducedMotion() {
  return globalThis.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false;
}

/**
 * How far the pulses are switched on at `nowMs`: 0 at rest, rising to 1 over
 * `settleMs` from `wake.startMs` and falling back to 0 over `settleMs` up to
 * `wake.untilMs`.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {{startMs: number, untilMs: number}} wake Window from `wakeAwarenessPulses`.
 * @param {object} [pulse] Timing, see `AWARENESS_RANGE_PULSE`.
 * @returns {number} 0 to 1.
 */
export function awarenessPulseLevel(
  nowMs,
  wake,
  pulse = AWARENESS_RANGE_PULSE,
) {
  const level = Math.min(
    (nowMs - wake.startMs) / pulse.settleMs,
    (wake.untilMs - nowMs) / pulse.settleMs,
  );
  return Math.max(0, Math.min(1, level));
}

/**
 * Run the pulses for `activeMs` from `nowMs`. A wake while they already run
 * keeps their current level, so they never jump back to full mid-fade.
 * @param {{startMs: number, untilMs: number}} wake Updated in place.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {object} [pulse] Timing, see `AWARENESS_RANGE_PULSE`.
 * @returns {{startMs: number, untilMs: number}} `wake`.
 */
export function wakeAwarenessPulses(
  wake,
  nowMs,
  pulse = AWARENESS_RANGE_PULSE,
) {
  wake.startMs =
    nowMs - awarenessPulseLevel(nowMs, wake, pulse) * pulse.settleMs;
  wake.untilMs = nowMs + pulse.activeMs;
  return wake;
}

/**
 * How strongly the 250 km ring shows at `nowMs` while pulses run: 1 as a
 * pulse front reaches it, fading over `flashMs`, so the ring appears once
 * per arriving pulse instead of standing on screen.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @returns {number} 0 to 1.
 */
export function awarenessRingFlash(nowMs) {
  return awarenessEchoStrength(
    nowMs,
    AWARENESS_RADIUS_M,
    AWARENESS_RADIUS_M,
    AWARENESS_RANGE_PULSE,
    { fadeMs: AWARENESS_RANGE_RING_STYLE.flashMs },
  );
}

/** Most pulses the pulse shader draws; its uniforms are vec4s. */
export const AWARENESS_PULSE_GRADIENT_MAX = 4;

/** The pulse disc's Cesium material type, one cached template per page. */
const AWARENESS_PULSE_MATERIAL_TYPE = 'GevAwarenessPulseGradient';

// Ellipse texture coordinates put the centre at (0.5, 0.5) and the rim at
// distance 0.5, so `r` is the fraction of the range. Each pulse is a line
// `lineWidth` CSS pixels wide whose outer `haloWidth` is a dark halo, half
// on each side, as Cesium's polyline outline material draws it, with a band
// behind it that is strongest at the line and fades to nothing `depth`
// inward. Widths come from the screen-space gradient of `r`, as Cesium's
// contour material measures its lines; without derivatives the lines are
// left out and only the band shows.
const PULSE_GRADIENT_SOURCE = `
uniform vec4 color;
uniform vec4 lineColor;
uniform vec4 haloColor;
uniform vec4 radii;
uniform vec4 alphas;
uniform float depth;
uniform float lineWidth;
uniform float haloWidth;
vec4 over(vec4 top, vec4 under) {
  float a = top.a + under.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float r = length(materialInput.st - vec2(0.5)) * 2.0;
  float band = 0.0;
  for (int i = 0; i < 4; i++) {
    float inside = radii[i] - r;
    if (inside >= 0.0 && inside <= depth) {
      float t = 1.0 - inside / depth;
      band += alphas[i] * t * t;
    }
  }
  vec4 result = vec4(color.rgb, clamp(band * color.a, 0.0, 1.0));
#if (__VERSION__ == 300 || defined(GL_OES_standard_derivatives))
  // Change in r per CSS pixel: the gradient's length per device pixel,
  // times the device pixels in one CSS pixel.
  float cssPx = max(length(vec2(dFdx(r), dFdy(r))), 1e-7) * czm_pixelRatio;
  float outerHalf = lineWidth * 0.5;
  float coreHalf = max(lineWidth - haloWidth, 0.0) * 0.5;
  for (int i = 0; i < 4; i++) {
    float d = abs(radii[i] - r) / cssPx;
    float cover = clamp(outerHalf + 0.5 - d, 0.0, 1.0);
    if (cover <= 0.0) continue;
    float core = clamp(coreHalf + 0.5 - d, 0.0, 1.0);
    vec4 pulse = mix(haloColor, lineColor, core);
    result = over(vec4(pulse.rgb, pulse.a * cover * alphas[i]), result);
  }
#endif
  material.diffuse = result.rgb;
  material.alpha = result.a;
  return material;
}
`;

/**
 * The pulses: one flat, translucent, unpickable disc the size of the range
 * ring whose shader draws each pulse line and the band behind it. Drawing
 * them here rather than as entities keeps them out of picking, so clicks and
 * taps near a pulse still reach the contact underneath. Moving pulses only
 * change its uniforms; the disc is rebuilt only when the subject moves.
 * @param {Cesium.Cartesian3} groundCenter Disc centre on the ellipsoid.
 * @param {Cesium.Material} material Shared pulse-gradient material.
 * @returns {Cesium.Primitive}
 */
function createPulseGradient(groundCenter, material) {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.EllipseGeometry({
        center: groundCenter,
        semiMajorAxis: AWARENESS_RADIUS_M,
        semiMinorAxis: AWARENESS_RADIUS_M,
        height: CONTEXT_RIM_HEIGHT_M,
        granularity: Cesium.Math.toRadians(
          AWARENESS_RANGE_PULSE.gradientGranularityDeg,
        ),
        vertexFormat:
          Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material,
      flat: true,
      translucent: true,
      faceForward: true,
    }),
    asynchronous: false,
    allowPicking: false,
  });
}

/**
 * The ring's polyline geometry: `AWARENESS_RANGE_RING_STYLE.width` screen
 * pixels, straight chords between the given positions (they already follow
 * the surface), in the material appearance's vertex format.
 * @param {Cesium.Cartesian3[]} positions Ring positions.
 * @returns {object} PolylineGeometry options.
 */
export function awarenessRingGeometryOptions(positions) {
  return {
    positions,
    width: AWARENESS_RANGE_RING_STYLE.width,
    arcType: Cesium.ArcType.NONE,
    vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
  };
}

/**
 * The 250 km ring as an unpickable polyline primitive in the ring's outline
 * material, so a click or tap on its edge reaches the contact underneath.
 * Its positions are geometry, so a moved subject rebuilds it; the material
 * is shared between builds so a flash keeps going.
 * @param {Cesium.Cartesian3[]} positions Ring positions.
 * @param {Cesium.Material} material Shared PolylineOutline material.
 * @returns {Cesium.Primitive}
 */
function createRingPrimitive(positions, material) {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.PolylineGeometry(
        awarenessRingGeometryOptions(positions),
      ),
    }),
    appearance: new Cesium.PolylineMaterialAppearance({
      material,
      translucent: true,
    }),
    asynchronous: false,
    allowPicking: false,
  });
}

/**
 * The rotation about the Earth's centre that carries `from` onto `to`, as a
 * model matrix, so a disc built around `from` sits around `to`.
 * @param {Cesium.Cartesian3} from Where the disc was built.
 * @param {Cesium.Cartesian3} to Where it should be.
 * @param {Cesium.Matrix4} [result]
 * @returns {Cesium.Matrix4}
 */
export function discFollowMatrix(from, to, result = new Cesium.Matrix4()) {
  const a = Cesium.Cartesian3.normalize(from, new Cesium.Cartesian3());
  const b = Cesium.Cartesian3.normalize(to, new Cesium.Cartesian3());
  const axis = Cesium.Cartesian3.cross(a, b, new Cesium.Cartesian3());
  const sin = Cesium.Cartesian3.magnitude(axis);
  if (sin < 1e-12) return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, result);
  const angle = Math.atan2(sin, Cesium.Cartesian3.dot(a, b));
  const rotation = Cesium.Matrix3.fromQuaternion(
    Cesium.Quaternion.fromAxisAngle(
      Cesium.Cartesian3.divideByScalar(axis, sin, axis),
      angle,
    ),
  );
  return Cesium.Matrix4.fromRotationTranslation(
    rotation,
    Cesium.Cartesian3.ZERO,
    result,
  );
}

/** Camera height above the ellipsoid, or NaN when the scene cannot say. */
function cameraHeightM(scene) {
  return scene.camera?.positionCartographic?.height ?? Number.NaN;
}

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { getKeyholeGeometry, celestialScreenAngle } = services.geometry;
  const { governorRequestRender } = services.render;

  const CARDINALS = [
    ['N', 0],
    ['E', 90],
    ['S', 180],
    ['W', 270],
  ];

  /**
   * The direction overlay as its view renders it: the compass ring, its
   * cardinals and heading, and up to three contact markers inside the
   * viewer's container. Each part keeps its last placement while hidden.
   */
  function ensureDirectionOverlay() {
    if (layerState.directionView || !layerState.viewer)
      return layerState.directionView;
    presentDirection({
      container: layerState.viewer.container,
      hidden: true,
      ring: null,
      heading: { text: '', left: null, top: null },
      labels: CARDINALS.map(([label, bearing]) => ({
        label,
        bearing,
        left: null,
        top: null,
      })),
      markers: Array.from({ length: 3 }, () => ({
        hidden: false,
        style: null,
        arrow: null,
        caption: { text: '', style: null },
      })),
    });
    return layerState.directionView;
  }

  /** Publish a change to the overlay, skipping one that changes nothing. */
  function presentDirection(patch) {
    const next = patch && { ...layerState.directionView, ...patch };
    const signature = JSON.stringify(next, (name, value) =>
      name === 'container' ? undefined : value,
    );
    if (next && signature === layerState.directionSignature) return;
    layerState.directionSignature = next ? signature : '';
    layerState.directionView = next && Object.freeze(next);
    for (const listener of [...layerState.directionListeners])
      listener(layerState.directionView);
  }

  /**
   * Receive the direction overlay now and after every change.
   * @param {(view: ?object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function subscribeDirectionOverlay(listener) {
    layerState.directionListeners.add(listener);
    listener(layerState.directionView);
    return () => layerState.directionListeners.delete(listener);
  }

  /** Hide the overlay, keeping its last placement. */
  function hideDirectionOverlay() {
    if (layerState.directionView) presentDirection({ hidden: true });
  }

  /** Withdraw the overlay when the layer is destroyed. */
  function removeDirectionOverlay() {
    if (layerState.directionView) presentDirection(null);
    layerState.directionAngles = [0, 0, 0];
  }

  function scheduleDirectionOverlayUpdate(force = false) {
    if (layerState.directionFrame !== null || !layerState.enabled) return;
    const now = Date.now();
    if (
      !force &&
      now - layerState.lastDirectionUpdateMs <
        parts.model.awarenessRefreshIntervalMs(layerState.cameraMoving)
    )
      return;
    layerState.directionFrame = window.requestAnimationFrame(() => {
      layerState.directionFrame = null;
      layerState.lastDirectionUpdateMs = Date.now();
      updateDirectionOverlay();
    });
  }

  function cancelDirectionOverlayUpdate() {
    if (layerState.directionFrame !== null)
      window.cancelAnimationFrame(layerState.directionFrame);
    layerState.directionFrame = null;
    layerState.lastDirectionUpdateMs = 0;
  }

  function updateDirectionOverlay() {
    const root = ensureDirectionOverlay();
    if (
      !root ||
      !layerState.enabled ||
      !layerState.subject?.position ||
      !layerState.results
    ) {
      if (root) presentDirection({ hidden: true });
      return;
    }

    const canvas = layerState.viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const sonar = isCyberSonarActive()
      ? createCyberSonarSampler(width, height)
      : null;
    const geometry = getKeyholeGeometry(width, height);
    if (!(geometry.radius > 0)) {
      presentDirection({ hidden: true });
      return;
    }

    // Keep the compass comfortably inside the shader keyhole so its cardinals
    // remain visible around the subject instead of hiding under edge panels.
    const compassRadius = Math.max(
      120,
      Math.min(geometry.radius - 48, geometry.radius * 0.66),
    );
    const cameraHeading = layerState.viewer.camera.heading || 0;
    const headingDeg =
      (Math.round(Cesium.Math.toDegrees(cameraHeading)) + 360) % 360;
    const ring = {
      left: `${geometry.centerX - compassRadius}px`,
      top: `${geometry.centerY - compassRadius}px`,
      width: `${compassRadius * 2}px`,
      height: `${compassRadius * 2}px`,
      '--compass-rotation': `${-headingDeg}deg`,
    };
    const heading = {
      text: t('HDG {value}°', {
        value: String(headingDeg).padStart(3, '0'),
      }),
      left: `${geometry.centerX}px`,
      top: `${geometry.centerY - compassRadius + 39}px`,
    };
    const labels = root.labels.map((label) => {
      const bearing = Cesium.Math.toRadians(label.bearing);
      const angle = bearing - cameraHeading - Cesium.Math.PI_OVER_TWO;
      const labelRadius = compassRadius - 17;
      return {
        ...label,
        left: `${geometry.centerX + Math.cos(angle) * labelRadius}px`,
        top: `${geometry.centerY + Math.sin(angle) * labelRadius}px`,
      };
    });

    const directionalCohort =
      layerState.results.cohorts.find(
        (cohort) => cohort.id === layerState.subject.layerId,
      ) ||
      layerState.results.cohorts.find((cohort) => cohort.id === 'military');
    const page = layerState.cohortPages.get(directionalCohort?.id) || 0;
    const military =
      directionalCohort?.summary.nearest.slice(
        page,
        page + AWARENESS_PAGE_SIZE,
      ) || [];
    const markers = root.markers.map((marker) => ({ ...marker }));
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      const item = military[index];
      if (!item?.position) {
        marker.hidden = true;
        continue;
      }
      const direction = Cesium.Cartesian3.subtract(
        item.position,
        layerState.subject.position,
        layerState.DIRECTION_SCRATCH[index],
      );
      if (Cesium.Cartesian3.magnitudeSquared(direction) < 1) {
        marker.hidden = true;
        continue;
      }
      Cesium.Cartesian3.normalize(direction, direction);
      const projection = celestialScreenAngle(
        Cesium.Cartesian3.dot(direction, layerState.viewer.camera.rightWC),
        Cesium.Cartesian3.dot(direction, layerState.viewer.camera.upWC),
        layerState.directionAngles[index],
      );
      if (projection.stable)
        layerState.directionAngles[index] = projection.angle;
      // Every detected contact shares the compass rim. Keeping the bearing
      // markers on one radius makes them read as compass contacts rather than
      // unconstrained labels floating over the map.
      const markerRadius = compassRadius;
      marker.style = {
        left: `${geometry.centerX + Math.cos(projection.angle) * markerRadius}px`,
        top: `${geometry.centerY + Math.sin(projection.angle) * markerRadius}px`,
        opacity: String(projection.opacity),
      };
      const sonarFactor =
        sonar?.at(
          geometry.centerX + Math.cos(projection.angle) * markerRadius,
          geometry.centerY + Math.sin(projection.angle) * markerRadius,
        ) ?? 1;
      marker.arrow = {
        opacity: String(sonarFactor),
        transform: `translate(-50%, -50%) rotate(${projection.angle}rad)`,
      };
      const labelStyle = {
        opacity: String(sonar ? sonar.label(sonarFactor) : 1),
        transform: `translate(-50%, -50%) translate(${-Math.cos(projection.angle) * 56}px, ${-Math.sin(projection.angle) * 56}px)`,
      };
      const label = formatAwarenessLabel(item);
      const subjectCartographic = Cesium.Cartographic.fromCartesian(
        layerState.subject.position,
        undefined,
        layerState.SUBJECT_CARTOGRAPHIC_SCRATCH,
      );
      const targetCartographic = Cesium.Cartographic.fromCartesian(
        item.position,
        undefined,
        layerState.TARGET_CARTOGRAPHIC_SCRATCH[index],
      );
      const bearing =
        subjectCartographic && targetCartographic
          ? bearingBetweenCoordinates(
              Cesium.Math.toDegrees(subjectCartographic.latitude),
              Cesium.Math.toDegrees(subjectCartographic.longitude),
              Cesium.Math.toDegrees(targetCartographic.latitude),
              Cesium.Math.toDegrees(targetCartographic.longitude),
            )
          : null;
      const bearingText = Number.isFinite(bearing)
        ? t('BRG {value}°', {
            value: formatAwarenessDirection(bearing),
          })
        : t('BRG —');
      const courseText = Number.isFinite(item.track)
        ? ` · ${t('CRS {value}°', {
            value: formatAwarenessDirection(item.track),
          })}`
        : '';
      marker.caption = {
        text: `${label} · ${formatAwarenessDistance(item.distanceM)}\n${bearingText}${courseText}`,
        style: labelStyle,
      };
      marker.hidden = false;
    }
    presentDirection({ hidden: false, ring, heading, labels, markers });
  }

  /**
   * Run the range pulses again for `activeMs`, after a camera move. Call it
   * during a frame (lifecycle's preRender): that frame's postRender arms the
   * next request, so waking asks for no extra frame of its own.
   */
  function wakePulses() {
    const wake = layerState.visual?.wake;
    if (!wake) return;
    wakeAwarenessPulses(wake, performance.now());
    followPulseDisc();
  }

  /**
   * Keep the pulse disc centred on the subject. Within `gradientRebuildM` of
   * where it was built, the disc is rotated about the Earth's centre onto
   * the subject by its model matrix, which keeps it concentric with the ring
   * at no build cost; the ellipsoid curves a little differently from that
   * sphere, a few tens of metres in height at 20 km. Further away it is
   * rebuilt, which costs a few milliseconds.
   */
  function followPulseDisc() {
    const { gradient, gradientCenter, center } = layerState.visual;
    if (!gradient) return;
    if (
      Cesium.Cartesian3.distance(gradientCenter, center) <
      AWARENESS_RANGE_PULSE.gradientRebuildM
    ) {
      gradient.modelMatrix = discFollowMatrix(
        gradientCenter,
        center,
        gradient.modelMatrix,
      );
      return;
    }
    const primitives = layerState.viewer.scene.primitives;
    layerState.visual.gradient = primitives.add(
      createPulseGradient(center, gradient.appearance.material),
    );
    // Primitive.destroy leaves the material alone, so the new disc keeps
    // sharing it.
    primitives.remove(gradient);
    Cesium.Cartesian3.clone(center, gradientCenter);
  }

  function clearVisual() {
    layerState.visual?.stopPulses?.();
    layerState.visual?.removeMotionListener?.();
    if (layerState.visual?.gradient && layerState.viewer)
      layerState.viewer.scene.primitives.remove(layerState.visual.gradient);
    if (layerState.visual?.ringPrimitive && layerState.viewer) {
      layerState.viewer.scene.primitives.remove?.(
        layerState.visual.ringPrimitive,
      );
      governorRequestRender('awareness-visual');
    }
    clearAwarenessEchoField();
    if (layerState.visual?.entities && layerState.viewer) {
      for (const entity of layerState.visual.entities)
        layerState.viewer.entities.remove(entity);
      // Idle mode renders only on request; a removed ring must not linger.
      governorRequestRender('awareness-visual');
    }
    layerState.visual = null;
  }

  function renderVisual(subject) {
    if (!layerState.viewer || !subject?.position) return;
    const cartographic = Cesium.Cartographic.fromCartesian(subject.position);
    if (!cartographic) return;
    const groundCenter = Cesium.Cartesian3.fromRadians(
      cartographic.longitude,
      cartographic.latitude,
      0,
    );
    const key = `${subject.layerId}:${subject.id}`;
    const reducedMotion = prefersReducedMotion();
    // A reduced-motion change rebuilds the visual, with or without pulses.
    if (
      layerState.visual?.key === key &&
      layerState.visual.reducedMotion === reducedMotion
    ) {
      // Move the ring only after a meaningful displacement so live tracking
      // does not rebuild its geometry for sub-pixel motion every 750 ms.
      if (
        Cesium.Cartesian3.distance(layerState.visual.center, groundCenter) >=
        250
      ) {
        const positions = awarenessRangeRingPositions(
          groundCenter,
          AWARENESS_RADIUS_M,
          CONTEXT_RIM_HEIGHT_M,
        );
        // The echo field reads `visual.center` in place and follows on its
        // own. The pulse disc follows by its model matrix and is rebuilt only
        // every `gradientRebuildM`: a build costs a few milliseconds.
        layerState.visual.ringPositions = positions;
        const { ringPrimitive } = layerState.visual;
        if (ringPrimitive) {
          const primitives = layerState.viewer.scene.primitives;
          layerState.visual.ringPrimitive = primitives.add(
            createRingPrimitive(positions, ringPrimitive.appearance.material),
          );
          primitives.remove(ringPrimitive);
        } else layerState.visual.ring.polyline.positions.setValue(positions);
        Cesium.Cartesian3.clone(groundCenter, layerState.visual.center);
        // A resting disc is hidden, so it catches up when the pulses wake.
        if (performance.now() < layerState.visual.wake?.untilMs)
          followPulseDisc();
        // Content actually changed — buy exactly one frame instead of holding.
        governorRequestRender('awareness-visual');
      }
      return;
    }
    clearVisual();

    const entities = [];
    const scene = layerState.viewer.scene;
    // A viewer without a primitive collection or a preRender hook (headless
    // tools, partial stubs) gets the static ring only, as the Cyber sonar
    // scene does. So does a viewer who prefers reduced motion.
    const animate = Boolean(
      !reducedMotion &&
      scene?.primitives?.add &&
      scene?.preRender?.addEventListener &&
      scene?.postRender?.addEventListener,
    );
    // Pulses run from now until `wake.untilMs`, then rest.
    const wake = animate
      ? wakeAwarenessPulses(
          { startMs: -Infinity, untilMs: -Infinity },
          performance.now(),
        )
      : null;
    // From a camera below the rim height the disc would sweep across the sky,
    // so it is hidden there, and the pulses rest with it: no flash, no
    // echoes, no frames.
    const belowRim = () => cameraHeightM(scene) < CONTEXT_RIM_HEIGHT_M;
    const levelAt = (nowMs) =>
      wake && !belowRim() ? awarenessPulseLevel(nowMs, wake) : 0;

    // A polyline, not an ellipse outline: WebGL draws ellipse outlines at
    // 1 px whatever `outlineWidth` says, and the ring needs a halo.
    const ring = AWARENESS_RANGE_RING_STYLE;
    const core = Cesium.Color.fromCssColorString(ring.color);
    const halo = Cesium.Color.fromCssColorString(ring.outlineColor);
    const ringPositions = awarenessRangeRingPositions(
      groundCenter,
      AWARENESS_RADIUS_M,
      CONTEXT_RIM_HEIGHT_M,
    );
    // While pulses run, the ring flashes as each one arrives and otherwise
    // dims to `restOpacity`; as they settle it returns to full and stays.
    const ringAlpha = (nowMs) => {
      const pulsed = Math.max(ring.restOpacity, awarenessRingFlash(nowMs));
      return 1 - levelAt(nowMs) * (1 - pulsed);
    };
    let ringEntity = null;
    let ringMaterial = null;
    let ringPrimitive = null;
    if (scene?.primitives?.add) {
      ringMaterial = Cesium.Material.fromType('PolylineOutline', {
        color: core.clone(),
        outlineColor: halo.clone(),
        outlineWidth: ring.outlineWidth,
      });
      ringPrimitive =
        scene.primitives.add(
          createRingPrimitive(ringPositions, ringMaterial),
        ) ?? null;
    }
    if (!ringPrimitive) {
      // Headless tools and partial stubs have no primitive collection; they
      // get the static ring as an entity.
      ringEntity = layerState.viewer.entities.add({
        polyline: {
          positions: new Cesium.ConstantProperty(ringPositions),
          width: ring.width,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineOutlineMaterialProperty({
            color: core,
            outlineColor: halo,
            outlineWidth: ring.outlineWidth,
          }),
        },
      });
      entities.push(ringEntity);
    }

    const center = Cesium.Cartesian3.clone(groundCenter);
    let gradient = null;
    let stopPulses = null;
    if (animate) {
      const pulse = AWARENESS_RANGE_PULSE;
      const count = Math.min(pulse.count, AWARENESS_PULSE_GRADIENT_MAX);
      const uniforms = {
        color: core.clone(),
        lineColor: core.clone(),
        haloColor: halo.clone(),
        radii: new Cesium.Cartesian4(),
        alphas: new Cesium.Cartesian4(),
        depth: pulse.gradientDepthFraction,
        lineWidth: pulse.width,
        haloWidth: pulse.outlineWidth,
      };
      uniforms.color.alpha = pulse.gradientOpacity;
      // A named type: Cesium caches every material type for the page's
      // lifetime, so an unnamed fabric (a fresh GUID each time) would leave
      // one entry per new visual. Built from the cached template, the
      // uniforms come back as plain copies; restore this visual's own.
      const material = new Cesium.Material({
        fabric: {
          type: AWARENESS_PULSE_MATERIAL_TYPE,
          uniforms,
          source: PULSE_GRADIENT_SOURCE,
        },
        translucent: true,
      });
      Object.assign(material.uniforms, uniforms);
      gradient = scene.primitives.add(
        createPulseGradient(groundCenter, material),
      );
      const radii = [0, 0, 0, 0];
      const alphas = [0, 0, 0, 0];
      const removePreRender = scene.preRender.addEventListener(() => {
        const nowMs = performance.now();
        const level = levelAt(nowMs);
        const alpha = ringAlpha(nowMs);
        ringMaterial.uniforms.color.alpha = core.alpha * alpha;
        ringMaterial.uniforms.outlineColor.alpha = halo.alpha * alpha;
        // The disc is looked up each frame: a subject move swaps it.
        const disc = layerState.visual?.gradient;
        if (disc) disc.show = level > 0;
        for (let index = 0; index < count; index++) {
          const state = awarenessPulseState(nowMs, index);
          radii[index] = state.radiusM / AWARENESS_RADIUS_M;
          alphas[index] = state.alpha * level;
        }
        Cesium.Cartesian4.fromArray(radii, 0, material.uniforms.radii);
        Cesium.Cartesian4.fromArray(alphas, 0, material.uniforms.alphas);
      });
      // Each drawn frame, whoever asked for it, arms one request a Cyber
      // sonar interval later, as the Cyber sonar scene does. Requests never
      // land within 80 ms of a frame, so they cannot beat the detection
      // lane's 80 ms gate, and they stop once the pulses rest.
      let timer = null;
      const removePostRender = scene.postRender.addEventListener(() => {
        globalThis.clearTimeout(timer);
        timer = null;
        if (performance.now() < wake.untilMs && !belowRim())
          timer = globalThis.setTimeout(() => {
            timer = null;
            governorRequestRender('awareness-pulse');
          }, CYBER_SONAR_RENDER_INTERVAL_MS);
      });
      stopPulses = () => {
        removePreRender();
        removePostRender();
        globalThis.clearTimeout(timer);
        timer = null;
      };
      // The detection overlay pulses the brackets of flights and vessels a
      // front crosses; it reads the centre in place, so it follows too.
      setAwarenessEchoField({
        center,
        radiusM: AWARENESS_RADIUS_M,
        pulse,
        echo: AWARENESS_RANGE_ECHO,
        level: levelAt,
      });
    }

    // Turning reduced motion on or off mid-session rebuilds the visual.
    const motionQuery = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    const onMotionChange = () => {
      if (layerState.subject) renderVisual(layerState.subject);
    };
    // Safari before 14 has only the older addListener / removeListener.
    if (motionQuery?.addEventListener)
      motionQuery.addEventListener('change', onMotionChange);
    else motionQuery?.addListener?.(onMotionChange);

    layerState.visual = {
      key,
      entities,
      ring: ringEntity,
      ringPrimitive,
      ringPositions,
      center,
      gradient,
      gradientCenter: Cesium.Cartesian3.clone(groundCenter),
      reducedMotion,
      wake,
      stopPulses,
      removeMotionListener: () => {
        if (motionQuery?.removeEventListener)
          motionQuery.removeEventListener('change', onMotionChange);
        else motionQuery?.removeListener?.(onMotionChange);
      },
    };
    governorRequestRender('awareness-visual');
  }
  return {
    ensureDirectionOverlay,
    subscribeDirectionOverlay,
    hideDirectionOverlay,
    removeDirectionOverlay,
    scheduleDirectionOverlayUpdate,
    cancelDirectionOverlayUpdate,
    updateDirectionOverlay,
    clearVisual,
    renderVisual,
    wakePulses,
  };
}
