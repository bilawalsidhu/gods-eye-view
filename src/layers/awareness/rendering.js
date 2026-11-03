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
  AWARENESS_RANGE_RING_STYLE,
  CONTEXT_RIM_HEIGHT_M,
} from './policy.js';
import { formatAwarenessDirection } from './presentation.js';

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
        for (const entity of layerState.visual.entities)
          entity.polyline.positions.setValue(positions);
        Cesium.Cartesian3.clone(groundCenter, layerState.visual.center);
        // Content actually changed — buy exactly one frame instead of holding.
        governorRequestRender('awareness-visual');
      }
      return;
    }
    clearVisual();

    const entities = [];

    // A polyline, not an ellipse outline: WebGL draws ellipse outlines at
    // 1 px whatever `outlineWidth` says, and the ring needs a halo.
    const ring = AWARENESS_RANGE_RING_STYLE;
    entities.push(
      layerState.viewer.entities.add({
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
            color: Cesium.Color.fromCssColorString(ring.color),
            outlineColor: Cesium.Color.fromCssColorString(ring.outlineColor),
            outlineWidth: ring.outlineWidth,
          }),
        },
      }),
    );

    layerState.visual = {
      key,
      entities,
      center: Cesium.Cartesian3.clone(groundCenter),
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
