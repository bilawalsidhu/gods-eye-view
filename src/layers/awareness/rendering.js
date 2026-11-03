import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
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
 * ring within a few metres of the true geodesic radius at 250 km.
 * @param {Cesium.Cartesian3} groundCenter Ring centre on the ellipsoid.
 * @param {number} radiusM Surface radius in metres.
 * @param {number} heightM Height of the ring above the ellipsoid.
 * @param {number} [segments] Chords around the ring.
 * @param {Cesium.Cartesian3[]} [result] Array whose Cartesians are reused.
 * @returns {Cesium.Cartesian3[]} `segments + 1` positions; the last repeats the first.
 */
export function awarenessRangeRingPositions(
  groundCenter,
  radiusM,
  heightM,
  segments = AWARENESS_RANGE_RING_STYLE.segments,
  result = [],
) {
  const { latitude, longitude } =
    Cesium.Cartographic.fromCartesian(groundCenter);
  const { x: a, z: b } = Cesium.Ellipsoid.WGS84.radii;
  const e2 = 1 - (b * b) / (a * a);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const w = 1 - e2 * sinLat * sinLat;
  const meridional = (a * (1 - e2)) / (w * Math.sqrt(w));
  const primeVertical = a / Math.sqrt(w);
  const positions = result;
  positions.length = segments + 1;
  for (let i = 0; i <= segments; i++) {
    const bearing = ((i % segments) / segments) * Cesium.Math.TWO_PI;
    const cosB = Math.cos(bearing);
    const sinB = Math.sin(bearing);
    const angular =
      radiusM * ((cosB * cosB) / meridional + (sinB * sinB) / primeVertical);
    const lat = Math.asin(
      sinLat * Math.cos(angular) + cosLat * Math.sin(angular) * cosB,
    );
    const lon =
      longitude +
      Math.atan2(
        sinB * Math.sin(angular) * cosLat,
        Math.cos(angular) - sinLat * Math.sin(lat),
      );
    positions[i] = Cesium.Cartesian3.fromRadians(
      lon,
      lat,
      heightM,
      Cesium.Ellipsoid.WGS84,
      positions[i],
    );
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

/** Whether the viewer asked the system for less motion. */
function prefersReducedMotion() {
  return (
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ??
    false
  );
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

/** Most pulses the gradient shader draws; its uniforms are vec4s. */
export const AWARENESS_PULSE_GRADIENT_MAX = 4;

// Ellipse texture coordinates put the centre at (0.5, 0.5) and the rim at
// distance 0.5, so `r` is the fraction of the range. Behind each pulse line
// the band is strongest at the line and fades to nothing `depth` inward.
const PULSE_GRADIENT_SOURCE = `
uniform vec4 color;
uniform vec4 radii;
uniform vec4 alphas;
uniform float depth;
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float r = length(materialInput.st - vec2(0.5)) * 2.0;
  float alpha = 0.0;
  for (int i = 0; i < 4; i++) {
    float inside = radii[i] - r;
    if (inside >= 0.0 && inside <= depth) {
      float t = 1.0 - inside / depth;
      alpha += alphas[i] * t * t;
    }
  }
  material.diffuse = color.rgb;
  material.alpha = clamp(alpha * color.a, 0.0, 1.0);
  return material;
}
`;

/**
 * The pulse gradient: one flat, translucent, unpickable disc the size of the
 * range ring whose shader draws a band behind each pulse. Moving pulses only
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

  function clearVisual() {
    globalThis.clearInterval(layerState.visual?.pulseTimer);
    layerState.visual?.removePulseListener?.();
    if (layerState.visual?.gradient && layerState.viewer)
      layerState.viewer.scene.primitives.remove(layerState.visual.gradient);
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
    if (layerState.visual?.key === key) {
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
        // Pulse lines read `visual.center` every frame and follow on their
        // own. The gradient disc is geometry, so it is rebuilt, but only
        // every `gradientRebuildM`: a build costs a few milliseconds.
        layerState.visual.ring.polyline.positions.setValue(positions);
        Cesium.Cartesian3.clone(groundCenter, layerState.visual.center);
        const { gradient, gradientCenter } = layerState.visual;
        if (
          gradient &&
          Cesium.Cartesian3.distance(gradientCenter, groundCenter) >=
            AWARENESS_RANGE_PULSE.gradientRebuildM
        ) {
          const primitives = layerState.viewer.scene.primitives;
          layerState.visual.gradient = primitives.add(
            createPulseGradient(groundCenter, gradient.appearance.material),
          );
          // Primitive.destroy leaves the material alone, so the new disc
          // keeps sharing it.
          primitives.remove(gradient);
          Cesium.Cartesian3.clone(groundCenter, gradientCenter);
        }
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
      !prefersReducedMotion() &&
      scene?.primitives?.add &&
      scene?.preRender?.addEventListener,
    );

    // A polyline, not an ellipse outline: WebGL draws ellipse outlines at
    // 1 px whatever `outlineWidth` says, and the ring needs a halo.
    const ring = AWARENESS_RANGE_RING_STYLE;
    const core = Cesium.Color.fromCssColorString(ring.color);
    const halo = Cesium.Color.fromCssColorString(ring.outlineColor);
    // While pulses run, the ring flashes as each one arrives and otherwise
    // rests at `restOpacity`; without pulses it stays on screen.
    const flashing = (base) => {
      const color = base.clone();
      return new Cesium.CallbackProperty(() => {
        const flash = awarenessRingFlash(performance.now());
        color.alpha = base.alpha * Math.max(ring.restOpacity, flash);
        return color;
      }, false);
    };
    const ringEntity = layerState.viewer.entities.add({
      polyline: {
        positions: new Cesium.ConstantProperty(
          awarenessRangeRingPositions(
            groundCenter,
            AWARENESS_RADIUS_M,
            CONTEXT_RIM_HEIGHT_M,
          ),
        ),
        width: ring.width,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineOutlineMaterialProperty({
          color: animate ? flashing(core) : core,
          outlineColor: animate ? flashing(halo) : halo,
          outlineWidth: ring.outlineWidth,
        }),
      },
    });
    entities.push(ringEntity);

    const center = Cesium.Cartesian3.clone(groundCenter);
    let gradient = null;
    let removePulseListener = null;
    let pulseTimer = null;
    if (animate) {
      const pulse = AWARENESS_RANGE_PULSE;
      for (let index = 0; index < pulse.count; index++) {
        const positions = [];
        const coreColor = core.clone();
        const haloColor = halo.clone();
        const stateAt = () => awarenessPulseState(performance.now(), index);
        entities.push(
          layerState.viewer.entities.add({
            polyline: {
              positions: new Cesium.CallbackProperty(
                () =>
                  awarenessRangeRingPositions(
                    center,
                    stateAt().radiusM,
                    CONTEXT_RIM_HEIGHT_M,
                    pulse.segments,
                    positions,
                  ),
                false,
              ),
              width: pulse.width,
              arcType: Cesium.ArcType.NONE,
              material: new Cesium.PolylineOutlineMaterialProperty({
                color: new Cesium.CallbackProperty(() => {
                  coreColor.alpha = core.alpha * stateAt().alpha;
                  return coreColor;
                }, false),
                outlineColor: new Cesium.CallbackProperty(() => {
                  haloColor.alpha = halo.alpha * stateAt().alpha;
                  return haloColor;
                }, false),
                outlineWidth: pulse.outlineWidth,
              }),
            },
          }),
        );
      }
      const count = Math.min(pulse.count, AWARENESS_PULSE_GRADIENT_MAX);
      const uniforms = {
        color: core.clone(),
        radii: new Cesium.Cartesian4(),
        alphas: new Cesium.Cartesian4(),
        depth: pulse.gradientDepthFraction,
      };
      uniforms.color.alpha = pulse.gradientOpacity;
      const material = new Cesium.Material({
        fabric: { uniforms, source: PULSE_GRADIENT_SOURCE },
        translucent: true,
      });
      gradient = scene.primitives.add(
        createPulseGradient(groundCenter, material),
      );
      const radii = [0, 0, 0, 0];
      const alphas = [0, 0, 0, 0];
      removePulseListener = scene.preRender.addEventListener(() => {
        const nowMs = performance.now();
        for (let index = 0; index < count; index++) {
          const state = awarenessPulseState(nowMs, index);
          radii[index] = state.radiusM / AWARENESS_RADIUS_M;
          alphas[index] = state.alpha;
        }
        Cesium.Cartesian4.fromArray(radii, 0, material.uniforms.radii);
        Cesium.Cartesian4.fromArray(alphas, 0, material.uniforms.alphas);
      });
      // The detection overlay pulses the brackets of flights and vessels a
      // front crosses; it reads the centre in place, so it follows too.
      setAwarenessEchoField({
        center,
        radiusM: AWARENESS_RADIUS_M,
        pulse,
        echo: AWARENESS_RANGE_ECHO,
      });
      pulseTimer = globalThis.setInterval(
        () => governorRequestRender('awareness-pulse'),
        pulse.frameIntervalMs,
      );
    }

    layerState.visual = {
      key,
      entities,
      ring: ringEntity,
      center,
      gradient,
      gradientCenter: Cesium.Cartesian3.clone(groundCenter),
      removePulseListener,
      pulseTimer,
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
  };
}
