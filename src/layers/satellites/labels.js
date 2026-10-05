import {
  ISS_NORAD,
  DOCKED_SCAN_INTERVAL_MS,
  DOCKED_COMPANION_RADIUS_M,
  ISS_OVERLAY_SOURCE_ID,
  ISS_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';

export function createLabels({ state: layerState, services, parts, source }) {
  /** Build the persistent ISS ambient label from the cached point position. */

  function createIssOverlayEntry(position) {
    return {
      id: String(ISS_NORAD),
      position,
      variant: 'label',
      title: 'ISS',
      accent: '#ff4444',
      priority: 1000,
      collisionGroup: 'ambient-label',
      paintLane: 'ambient-label',
      interactive: false,
      distanceScale: {
        near: 1_000_000,
        nearValue: 1,
        far: 30_000_000,
        farValue: 0.4,
      },
      gapPx: 14,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /** Cached ISS point only; never performs a fresh SGP4 propagation. */

  function _issDisplayCached() {
    return layerState._points.get(ISS_NORAD)?.position || null;
  }

  /**
   * Rebuild the docked-companion set for the tracked satellite.
   * @returns {boolean} true when membership changed (callers resync presentation).
   */

  function _refreshDockedCompanions(nowMs) {
    const trackedPosition =
      layerState._trackedNorad === null
        ? null
        : parts.tracking._trackedDisplayCached();
    if (!trackedPosition) {
      if (layerState._dockedCompanions.size === 0) return false;
      layerState._dockedCompanions = new Set();
      return true;
    }
    if (nowMs - layerState._lastDockedScanMs < DOCKED_SCAN_INTERVAL_MS)
      return false;
    layerState._lastDockedScanMs = nowMs;
    const radiusSq = DOCKED_COMPANION_RADIUS_M * DOCKED_COMPANION_RADIUS_M;
    let changed = false;
    let found = 0;
    const next = new Set();
    for (const [noradId, point] of layerState._points) {
      if (noradId === layerState._trackedNorad || !point?.position) continue;
      const dx = point.position.x - trackedPosition.x;
      const dy = point.position.y - trackedPosition.y;
      const dz = point.position.z - trackedPosition.z;
      if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
      next.add(noradId);
      found++;
      if (!layerState._dockedCompanions.has(noradId)) changed = true;
    }
    if (found !== layerState._dockedCompanions.size) changed = true;
    if (changed) layerState._dockedCompanions = next;
    return changed;
  }

  /** Names of the docked companions, stable-sorted so the card text never churns. */

  function _dockedCompanionNames() {
    const names = [];
    for (const noradId of layerState._dockedCompanions) {
      names.push(
        layerState._catalog.get(noradId)?.name?.trim() || `SAT-${noradId}`,
      );
    }
    return names.sort();
  }

  /** Keep persistent ISS text mutually exclusive with the tracked host card. */

  function _syncIssOverlay() {
    // Hidden when ISS is the tracked subject, and equally when ISS is DOCKED to
    // whatever is tracked: its ambient label would otherwise sit underneath the
    // tracked card at the same position.
    const visible =
      layerState._enabled &&
      layerState._params.showOrbits &&
      layerState._trackedNorad !== ISS_NORAD &&
      !layerState._dockedCompanions.has(ISS_NORAD) &&
      layerState._catalog.has(ISS_NORAD) &&
      _issDisplayCached();
    if (!visible) {
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
      layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
      return;
    }
    layerState._overlayHost.setEntries(
      ISS_OVERLAY_SOURCE_ID,
      [createIssOverlayEntry(_issDisplayCached)],
      ISS_OVERLAY_SOURCE_OPTIONS,
    );
    layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, true);
  }
  return {
    createIssOverlayEntry,
    _issDisplayCached,
    _refreshDockedCompanions,
    _dockedCompanionNames,
    _syncIssOverlay,
  };
}
