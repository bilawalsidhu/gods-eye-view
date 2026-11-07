import * as geo from '../../geo/index.js';
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
 * @param {{x: number, y: number, z: number}} groundCenter Ring centre on the ellipsoid.
 * @param {number} radiusM Surface radius in metres.
 * @param {number} heightM Height of the ring above the ellipsoid.
 * @param {number} [segments] Chords around the ring.
 * @returns {Array<{x: number, y: number, z: number}>} `segments + 1`
 *   positions; the last repeats the first.
 */
export function awarenessRangeRingPositions(
  groundCenter,
  radiusM,
  heightM,
  segments = AWARENESS_RANGE_RING_STYLE.segments,
) {
  const { latitude, longitude } = geo.cartographic.fromCartesian(groundCenter);
  const { x: a, z: b } = geo.ellipsoid.WGS84.radii;
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
    const bearing = ((i % segments) / segments) * geo.math.TWO_PI;
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
    positions.push(geo.cartesian3.fromRadians(lon, lat, heightM));
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

/** Most pulses the pulse disc draws; its shader uniforms are vec4s. */
export const AWARENESS_PULSE_GRADIENT_MAX = 4;

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
    if (layerState.directionView || !layerState.display)
      return layerState.directionView;
    presentDirection({
      container: layerState.display.container,
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

    const canvas = layerState.display.canvas;
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
    const cameraHeading = layerState.display.camera.heading || 0;
    const headingDeg =
      (Math.round(geo.math.toDegrees(cameraHeading)) + 360) % 360;
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
      const bearing = geo.math.toRadians(label.bearing);
      const angle = bearing - cameraHeading - geo.math.PI_OVER_TWO;
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
      const direction = geo.cartesian3.subtract(
        item.position,
        layerState.subject.position,
        layerState.DIRECTION_SCRATCH[index],
      );
      if (geo.cartesian3.magnitudeSquared(direction) < 1) {
        marker.hidden = true;
        continue;
      }
      geo.cartesian3.normalize(direction, direction);
      const projection = celestialScreenAngle(
        geo.cartesian3.dot(direction, layerState.display.camera.rightWC),
        geo.cartesian3.dot(direction, layerState.display.camera.upWC),
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
      const subjectCartographic = geo.cartographic.fromCartesian(
        layerState.subject.position,
        undefined,
        layerState.SUBJECT_CARTOGRAPHIC_SCRATCH,
      );
      const targetCartographic = geo.cartographic.fromCartesian(
        item.position,
        undefined,
        layerState.TARGET_CARTOGRAPHIC_SCRATCH[index],
      );
      const bearing =
        subjectCartographic && targetCartographic
          ? bearingBetweenCoordinates(
              geo.math.toDegrees(subjectCartographic.latitude),
              geo.math.toDegrees(subjectCartographic.longitude),
              geo.math.toDegrees(targetCartographic.latitude),
              geo.math.toDegrees(targetCartographic.longitude),
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
   * next request, so waking asks for no extra frame of its own. A resting
   * disc was left where it was; it catches up with the subject now.
   */
  function wakePulses() {
    const visual = layerState.visual;
    if (!visual?.wake) return;
    wakeAwarenessPulses(visual.wake, performance.now());
    visual.disc?.move(visual.center);
  }

  function clearVisual() {
    const visual = layerState.visual;
    visual?.stopPulses?.();
    visual?.removeMotionListener?.();
    clearAwarenessEchoField();
    if (visual?.rim) {
      visual.rim.destroy();
      visual.disc?.destroy();
      // Idle mode renders only on request; a removed ring must not linger.
      governorRequestRender('awareness-visual', layerState.display?.engine);
    }
    layerState.visual = null;
  }

  /** A fresh pulse window, running from now. */
  function newWake() {
    return wakeAwarenessPulses(
      { startMs: -Infinity, untilMs: -Infinity },
      performance.now(),
    );
  }

  /**
   * How far the pulses are on at a time (0 at rest or while `belowRim()`),
   * and the ring's opacity: while pulses run it flashes as each one arrives
   * and otherwise dims to `restOpacity`; as they settle it returns to full.
   */
  function pulseClock(wake, belowRim) {
    const levelAt = (nowMs) =>
      wake && !belowRim() ? awarenessPulseLevel(nowMs, wake) : 0;
    const ringAlpha = (nowMs) => {
      const pulsed = Math.max(
        AWARENESS_RANGE_RING_STYLE.restOpacity,
        awarenessRingFlash(nowMs),
      );
      return 1 - levelAt(nowMs) * (1 - pulsed);
    };
    return { levelAt, ringAlpha, belowRim };
  }

  /**
   * Run the pulses on a globe: each frame `draw` gets the level, the ring's
   * opacity and the fronts (fractions of the range, opacities). Each drawn
   * frame, whoever asked for it, arms one request a Cyber sonar interval
   * later, as the Cyber sonar scene does. Requests never land within 80 ms
   * of a frame, so they cannot beat the detection lane's 80 ms gate, and
   * they stop once the pulses rest. The detection overlay pulses the
   * brackets of flights and vessels a front crosses; it reads `center` in
   * place, so it follows the subject too. Returns the stop.
   */
  function runPulses({
    center,
    wake,
    levelAt,
    ringAlpha,
    belowRim,
    onFrame,
    onFrameEnd,
    draw,
  }) {
    const pulse = AWARENESS_RANGE_PULSE;
    const count = Math.min(pulse.count, AWARENESS_PULSE_GRADIENT_MAX);
    const radii = [0, 0, 0, 0];
    const alphas = [0, 0, 0, 0];
    const removeFrame = onFrame(() => {
      const nowMs = performance.now();
      const level = levelAt(nowMs);
      for (let index = 0; index < count; index++) {
        const state = awarenessPulseState(nowMs, index);
        radii[index] = state.radiusM / AWARENESS_RADIUS_M;
        alphas[index] = state.alpha * level;
      }
      draw({ level, alpha: ringAlpha(nowMs), radii, alphas });
    });
    let timer = null;
    const removeFrameEnd = onFrameEnd(() => {
      globalThis.clearTimeout(timer);
      timer = null;
      if (performance.now() < wake.untilMs && !belowRim())
        timer = globalThis.setTimeout(() => {
          timer = null;
          governorRequestRender('awareness-pulse', layerState.display?.engine);
        }, CYBER_SONAR_RENDER_INTERVAL_MS);
    });
    setAwarenessEchoField({
      center,
      radiusM: AWARENESS_RADIUS_M,
      pulse,
      echo: AWARENESS_RANGE_ECHO,
      level: levelAt,
    });
    return () => {
      removeFrame?.();
      removeFrameEnd?.();
      globalThis.clearTimeout(timer);
      timer = null;
    };
  }

  /**
   * Rebuild the visual when reduced motion is turned on or off mid-session.
   * Returns the listener's removal.
   */
  function watchReducedMotion() {
    const motionQuery = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    const onMotionChange = () => {
      if (layerState.subject) renderVisual(layerState.subject);
    };
    // Safari before 14 has only the older addListener / removeListener.
    if (motionQuery?.addEventListener)
      motionQuery.addEventListener('change', onMotionChange);
    else motionQuery?.addListener?.(onMotionChange);
    return () => {
      if (motionQuery?.removeEventListener)
        motionQuery.removeEventListener('change', onMotionChange);
      else motionQuery?.removeListener?.(onMotionChange);
    };
  }

  /**
   * The visual through the display: its range ring and, unless reduced
   * motion is on or the engine cannot draw them, the pulses and their echoes.
   */
  function createVisual(key, groundCenter, reducedMotion) {
    const display = layerState.display;
    const center = geo.cartesian3.clone(groundCenter);
    const rim = display.createRim(groundCenter);
    const disc = reducedMotion
      ? null
      : (display.createPulses?.(groundCenter) ?? null);
    // Pulses run from now until `wake.untilMs`, then rest.
    const wake = disc ? newWake() : null;
    // From a camera below the rim height the disc would sweep across the sky,
    // so it is hidden there, and the pulses rest with it: no flash, no
    // echoes, no frames.
    const { levelAt, ringAlpha, belowRim } = pulseClock(
      wake,
      () => display.cameraHeight() < CONTEXT_RIM_HEIGHT_M,
    );
    const stopPulses = disc
      ? runPulses({
          center,
          wake,
          levelAt,
          ringAlpha,
          belowRim,
          onFrame: display.onFrame,
          onFrameEnd: display.onFrameEnd,
          draw({ level, alpha, radii, alphas }) {
            rim.setAlpha(alpha);
            disc.draw({ level, radii, alphas });
          },
        })
      : null;
    layerState.visual = {
      key,
      rim,
      disc,
      center,
      reducedMotion,
      wake,
      stopPulses,
      removeMotionListener: watchReducedMotion(),
    };
    governorRequestRender('awareness-visual', layerState.display?.engine);
  }

  function renderVisual(subject) {
    if (!layerState.display || !subject?.position) return;
    const cartographic = geo.cartographic.fromCartesian(subject.position);
    if (!cartographic) return;
    const groundCenter = geo.cartesian3.fromRadians(
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
      const visual = layerState.visual;
      if (geo.cartesian3.distance(visual.center, groundCenter) >= 250) {
        // The echo field reads `visual.center` in place and follows on its
        // own. A resting disc is hidden, so it catches up when the pulses wake.
        visual.rim.move(groundCenter);
        geo.cartesian3.clone(groundCenter, visual.center);
        if (performance.now() < visual.wake?.untilMs)
          visual.disc?.move(groundCenter);
        // Content actually changed — buy exactly one frame instead of holding.
        governorRequestRender('awareness-visual', layerState.display?.engine);
      }
      return;
    }
    clearVisual();
    createVisual(key, groundCenter, reducedMotion);
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
