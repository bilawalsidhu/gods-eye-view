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
import { AWARENESS_PAGE_SIZE, CONTEXT_RIM_HEIGHT_M } from './policy.js';
import { formatAwarenessDirection } from './presentation.js';
import { canvasOf, drawOf, findCamera } from '../../render/rendererOf.js';
import {
  PI_OVER_TWO,
  distance,
  dot,
  fromDegrees,
  normalize,
  sub,
  toDegrees,
  toLonLatH,
  toRadians,
} from '../../geo/index.js';

/** Each instance's rim set id is its own. */
let instances = 0;

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { getKeyholeGeometry, celestialScreenAngle } = services.geometry;
  const { governorRequestRender } = services.render;
  const rimSetId = `awareness:${++instances}:rim`;
  /** The context rim's draw set, and the viewer it draws on. */
  let rim = null;

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

    const canvas = canvasOf(layerState.viewer);
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
    const pose = findCamera(layerState.viewer)?.pose();
    const cameraHeading = pose?.heading || 0;
    const headingDeg = (Math.round(toDegrees(cameraHeading)) + 360) % 360;
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
      const bearing = toRadians(label.bearing);
      const angle = bearing - cameraHeading - PI_OVER_TWO;
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
      const offset = sub(item.position, layerState.subject.position);
      if (dot(offset, offset) < 1 || !pose) {
        marker.hidden = true;
        continue;
      }
      const direction = normalize(offset);
      const projection = celestialScreenAngle(
        dot(direction, pose.right),
        dot(direction, pose.up),
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
      const subjectLocation = toLonLatH(layerState.subject.position);
      const targetLocation = toLonLatH(item.position);
      const bearing =
        subjectLocation && targetLocation
          ? bearingBetweenCoordinates(
              subjectLocation.lat,
              subjectLocation.lon,
              targetLocation.lat,
              targetLocation.lon,
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
    if (layerState.visual && rim) {
      rim.set.clear();
      // Idle mode renders only on request; a removed ring must not linger.
      governorRequestRender('awareness-visual');
    }
    layerState.visual = null;
  }

  /** Let the rim's draw set go, as the layer is destroyed. */
  function disposeVisual() {
    clearVisual();
    rim?.set.dispose();
    rim = null;
  }

  /** The rim's draw set on the current viewer, made on first use. */
  function rimSet() {
    if (rim?.viewer !== layerState.viewer) {
      rim?.set.dispose();
      rim = {
        viewer: layerState.viewer,
        set: drawOf(layerState.viewer).shapes({ id: rimSetId }),
      };
    }
    return rim.set;
  }

  /** The awareness radius as an outlined ellipse around the subject's ground point. */
  function rimItem(lon, lat) {
    return {
      id: 'rim',
      geometry: {
        kind: 'ellipse',
        center: { lon, lat, height: CONTEXT_RIM_HEIGHT_M },
        semiMajor: AWARENESS_RADIUS_M,
        semiMinor: AWARENESS_RADIUS_M,
      },
      fill: null,
      outline: [0x62 / 255, 0xb5 / 255, 1, 0.72],
      outlineOnly: true,
      height: 'absolute',
    };
  }

  function renderVisual(subject) {
    if (!layerState.viewer || !subject?.position) return;
    const location = toLonLatH(subject.position);
    if (!location) return;
    const { lon, lat } = location;
    const groundCenter = fromDegrees(lon, lat, 0);
    const key = `${subject.layerId}:${subject.id}`;
    // A rim drawn on another viewer (the layer re-initialized) is redrawn.
    if (layerState.visual?.key === key && rim?.viewer === layerState.viewer) {
      // Move the large ring only after a meaningful displacement so live
      // tracking does not rebuild it for sub-pixel motion every 750 ms.
      if (distance(layerState.visual.center, groundCenter) >= 250) {
        rimSet().set([rimItem(lon, lat)]);
        layerState.visual.center = groundCenter;
        // Content actually changed — buy exactly one frame instead of holding.
        governorRequestRender('awareness-visual');
      }
      return;
    }
    clearVisual();
    rimSet().set([rimItem(lon, lat)]);
    layerState.visual = { key, center: groundCenter };
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
    disposeVisual,
    renderVisual,
  };
}
