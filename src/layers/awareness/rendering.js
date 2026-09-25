import * as Cesium from 'cesium';
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

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { getKeyholeGeometry, celestialScreenAngle } = services.geometry;
  const { governorRequestRender } = services.render;

  function ensureDirectionOverlay() {
    if (layerState.directionRoot || !layerState.viewer)
      return layerState.directionRoot;
    const root = document.createElement('div');
    root.id = 'military-awareness-direction-overlay';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');

    const compass = document.createElement('div');
    compass.className = 'military-awareness-compass-ring';
    const cardinals = [
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ];
    layerState.compassLabels = cardinals.map(([label, bearing]) => {
      const element = document.createElement('span');
      element.className = `military-awareness-compass-label cardinal-${label.toLowerCase()}`;
      element.textContent = label;
      element.dataset.bearing = String(bearing);
      root.appendChild(element);
      return element;
    });
    const heading = document.createElement('span');
    heading.className = 'military-awareness-compass-heading';
    root.append(compass, heading);

    layerState.directionMarkers = Array.from({ length: 3 }, () => {
      const marker = document.createElement('div');
      marker.className = 'military-awareness-direction-marker';
      const arrow = document.createElement('span');
      arrow.className = 'military-awareness-direction-arrow';
      arrow.textContent = '➜';
      const label = document.createElement('span');
      label.className = 'military-awareness-direction-label';
      marker.append(arrow, label);
      marker._arrow = arrow;
      marker._label = label;
      marker._lastAngle = 0;
      root.appendChild(marker);
      return marker;
    });

    layerState.compassRing = compass;
    layerState.compassHeading = heading;
    layerState.viewer.container.appendChild(root);
    layerState.directionRoot = root;
    return root;
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
      if (root) root.hidden = true;
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
      root.hidden = true;
      return;
    }

    root.hidden = false;
    // Keep the compass comfortably inside the shader keyhole so its cardinals
    // remain visible around the subject instead of hiding under edge panels.
    const compassRadius = Math.max(
      120,
      Math.min(geometry.radius - 48, geometry.radius * 0.66),
    );
    layerState.compassRing.style.left = `${geometry.centerX - compassRadius}px`;
    layerState.compassRing.style.top = `${geometry.centerY - compassRadius}px`;
    layerState.compassRing.style.width = `${compassRadius * 2}px`;
    layerState.compassRing.style.height = `${compassRadius * 2}px`;

    const cameraHeading = layerState.viewer.camera.heading || 0;
    const headingDeg =
      (Math.round(Cesium.Math.toDegrees(cameraHeading)) + 360) % 360;
    layerState.compassRing.style.setProperty(
      '--compass-rotation',
      `${-headingDeg}deg`,
    );
    layerState.compassHeading.textContent = `HDG ${String(headingDeg).padStart(3, '0')}°`;
    layerState.compassHeading.style.left = `${geometry.centerX}px`;
    layerState.compassHeading.style.top = `${geometry.centerY - compassRadius + 39}px`;
    for (const label of layerState.compassLabels) {
      const bearing = Cesium.Math.toRadians(Number(label.dataset.bearing));
      const angle = bearing - cameraHeading - Cesium.Math.PI_OVER_TWO;
      const labelRadius = compassRadius - 17;
      label.style.left = `${geometry.centerX + Math.cos(angle) * labelRadius}px`;
      label.style.top = `${geometry.centerY + Math.sin(angle) * labelRadius}px`;
    }

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
    for (let index = 0; index < layerState.directionMarkers.length; index++) {
      const marker = layerState.directionMarkers[index];
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
        marker._lastAngle,
      );
      if (projection.stable) marker._lastAngle = projection.angle;
      // Every detected contact shares the compass rim. Keeping the bearing
      // markers on one radius makes them read as compass contacts rather than
      // unconstrained labels floating over the map.
      const markerRadius = compassRadius;
      marker.style.left = `${geometry.centerX + Math.cos(projection.angle) * markerRadius}px`;
      marker.style.top = `${geometry.centerY + Math.sin(projection.angle) * markerRadius}px`;
      marker.style.opacity = String(projection.opacity);
      const sonarFactor =
        sonar?.at(
          geometry.centerX + Math.cos(projection.angle) * markerRadius,
          geometry.centerY + Math.sin(projection.angle) * markerRadius,
        ) ?? 1;
      marker._arrow.style.opacity = String(sonarFactor);
      marker._label.style.opacity = String(
        sonar ? sonar.label(sonarFactor) : 1,
      );
      marker._arrow.style.transform = `translate(-50%, -50%) rotate(${projection.angle}rad)`;
      marker._label.style.transform = `translate(-50%, -50%) translate(${-Math.cos(projection.angle) * 56}px, ${-Math.sin(projection.angle) * 56}px)`;
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
        ? `BRG ${String(Math.round(bearing)).padStart(3, '0')}°`
        : 'BRG —';
      const courseText = Number.isFinite(item.track)
        ? ` · CRS ${String(Math.round(item.track)).padStart(3, '0')}°`
        : '';
      marker._label.textContent = `${label} · ${formatAwarenessDistance(item.distanceM)}\n${bearingText}${courseText}`;
      marker.hidden = false;
    }
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
      // Large ellipse geometry is more reliable as a ConstantPositionProperty.
      // Move it only after a meaningful displacement so live tracking does not
      // churn ten large geometries for sub-pixel motion every 750 ms.
      if (
        Cesium.Cartesian3.distance(layerState.visual.center, groundCenter) >=
        250
      ) {
        for (const entity of layerState.visual.entities)
          entity.position.setValue(groundCenter);
        Cesium.Cartesian3.clone(groundCenter, layerState.visual.center);
        // Content actually changed — buy exactly one frame instead of holding.
        governorRequestRender('awareness-visual');
      }
      return;
    }
    clearVisual();

    const entities = [];

    entities.push(
      layerState.viewer.entities.add({
        position: groundCenter,
        ellipse: {
          semiMajorAxis: AWARENESS_RADIUS_M,
          semiMinorAxis: AWARENESS_RADIUS_M,
          fill: false,
          outline: true,
          outlineColor:
            Cesium.Color.fromCssColorString('#62b5ff').withAlpha(0.72),
          height: CONTEXT_RIM_HEIGHT_M,
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
    scheduleDirectionOverlayUpdate,
    cancelDirectionOverlayUpdate,
    updateDirectionOverlay,
    clearVisual,
    renderVisual,
  };
}
