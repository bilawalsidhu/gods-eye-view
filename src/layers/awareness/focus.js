import * as Cesium from 'cesium';
import { VESSEL_FOCUS_RADIUS_M } from './policy.js';

export function createFocus({ state: layerState, services, parts, source }) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;
  const { announceNavigationAuthority } = services.navigation;
  const militaryInstallationsLayer = services.installations;
  const aisLiveVesselsLayer = services.vessels;

  /** Focus a nearby example through the source layer that owns its selection. */

  function focusNearbyTarget(layerId, id, { origin = 'programmatic' } = {}) {
    if (!layerId || !id) return false;
    if (layerId === 'flights') {
      return (
        flightsLayer.refocusTrackedById?.(id, { origin }) ||
        flightsLayer.trackById(id, { origin })
      );
    }
    if (layerId === 'military') {
      return (
        militaryFlightsLayer.refocusTrackedById?.(id, { origin }) ||
        militaryFlightsLayer.trackById(id, { origin })
      );
    }
    if (layerId === 'military-installations') {
      if (!parts.model.contextTargetFlyToAllowed(layerId))
        return selectKnownContextTarget(layerId, id);
      // focusById flies the camera; it never assigns a tracked entity, so the
      // stamp has to be announced here.
      announceNavigationAuthority('context-installation-focus');
      return militaryInstallationsLayer.focusById(id);
    }
    if (layerId !== 'ais-live-vessels' || !aisLiveVesselsLayer.selectById(id))
      return false;

    const vessel = aisLiveVesselsLayer
      .getAllPositions(12000)
      .find((item) => String(item.id) === String(id));
    if (
      !parts.model.contextTargetFlyToAllowed(layerId) ||
      !vessel?.position ||
      !layerState.viewer
    )
      return true;
    announceNavigationAuthority('context-vessel-focus');
    layerState.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(vessel.position, VESSEL_FOCUS_RADIUS_M),
      { duration: 1.4 },
    );
    return true;
  }

  function selectKnownContextTarget(layerId, id) {
    const key = `${layerId}:${id}`;
    const known = [
      layerState.subject,
      ...layerState.navigationHistory,
      ...(layerState.results?.cohorts || []).flatMap((cohort) =>
        cohort.id === layerId
          ? cohort.summary.navigationNearest || cohort.summary.nearest || []
          : [],
      ),
    ].find(
      (item) =>
        item && `${item.layerId || layerId}:${item.id || item.mmsi}` === key,
    );
    if (!known?.position) return false;
    if (parts.model.contextTargetFlyToAllowed(layerId))
      parts.model.releaseAircraftTracking();
    parts.subject.selectSubject({
      ...known,
      layerId,
      id: String(known.id || known.mmsi),
      label: known.label || known.name || known.callsign || String(id),
      position: Cesium.Cartesian3.clone(known.position),
    });
    return true;
  }

  function requestFocus(
    layerId,
    id,
    preserveHistory = false,
    { origin = 'programmatic' } = {},
  ) {
    const key = `${layerId}:${id}`;
    layerState.pendingSelectionKey = key;
    if (preserveHistory) layerState.suppressedHistoryKey = key;
    const focused = focusNearbyTarget(layerId, id, { origin });
    layerState.pendingSelectionKey = null;
    layerState.suppressedHistoryKey = null;
    return focused;
  }

  function focusSubject(subject, preserveHistory = false, options = {}) {
    if (!subject) return false;
    return requestFocus(subject.layerId, subject.id, preserveHistory, options);
  }

  function focusCurrentSubject(options = {}) {
    return focusSubject(layerState.subject, true, options);
  }

  /**
   * Pick the observed candidate closest to the current view. This is intentionally
   * a navigation preference, not a risk, capability, or affiliation calculation.
   * @param {Array<{position: Cesium.Cartesian3}>} candidates Observed candidates.
   * @returns {Object|null} The best currently observable candidate.
   */

  function closestToCurrentView(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const cameraPosition = layerState.viewer?.camera?.positionWC;
    if (!cameraPosition)
      return candidates.find((candidate) => candidate?.position) || null;

    let closest = null;
    let closestDistance = Infinity;
    for (const candidate of candidates) {
      if (!candidate?.position) continue;
      const distance = Cesium.Cartesian3.distance(
        cameraPosition,
        candidate.position,
      );
      if (Number.isFinite(distance) && distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    return closest;
  }

  /**
   * Focus a single observed, context-priority target after activation. Civilian
   * and military aircraft compete in one nearest-to-view pool; military is
   * concatenated first so exact distance ties resolve to military under the
   * strict comparison. An AIS vessel is only a fallback and is never inferred
   * to be military. There is deliberately no distance cap.
   * @returns {boolean} Whether a target was selected and framed.
   */

  function focusAttentionTarget() {
    if (
      !layerState.enabled ||
      layerState.subject ||
      !layerState.viewer ||
      layerState.autoFocusAttempted
    )
      return false;

    const nearestFlight = closestToCurrentView([
      ...militaryFlightsLayer
        .getAllPositions(800)
        .map((item) => ({ ...item, layerId: 'military' })),
      ...flightsLayer
        .getAllPositions(1000)
        .map((item) => ({ ...item, layerId: 'flights' })),
    ]);
    if (nearestFlight) {
      const layer =
        nearestFlight.layerId === 'military'
          ? militaryFlightsLayer
          : flightsLayer;
      if (layer.trackById(nearestFlight.id, { origin: 'programmatic' })) {
        layerState.autoFocusAttempted = true;
        return true;
      }
    }

    const vessel = closestToCurrentView(
      aisLiveVesselsLayer.getAllPositions(12000),
    );
    if (!vessel || !aisLiveVesselsLayer.selectById(vessel.id)) return false;

    layerState.autoFocusAttempted = true;
    if (!parts.model.contextTargetFlyToAllowed('ais-live-vessels')) return true;

    announceNavigationAuthority('context-vessel-autofocus', {
      cancelPendingSelection: false,
    });
    layerState.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(vessel.position, VESSEL_FOCUS_RADIUS_M),
      { duration: 1.6 },
    );
    return true;
  }
  return {
    focusNearbyTarget,
    selectKnownContextTarget,
    requestFocus,
    focusSubject,
    focusCurrentSubject,
    closestToCurrentView,
    focusAttentionTarget,
  };
}
