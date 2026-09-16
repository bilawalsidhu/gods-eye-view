/*
 * Cockpit aircraft metadata itself is resolved by `resolveTrackedAircraftInfo`
 * in `cockpitMath.js` — the landed owner of that rule. It keeps layer
 * precedence as the fallback when no normalized `gevTrackedId` is available,
 * so tracking paths that never stamp one keep working; `readAircraftInfo` is
 * pinned to it by `cockpitMarkup.test.mjs`. This module owns only the
 * multi-step ENTRY TRANSACTION (adopt → enter → roll back).
 */

/**
 * Force the prior aircraft layer to reacquire Cesium and durable tracking ownership.
 * @param {object} layer Aircraft layer exposing `trackById`/`stopTracking`.
 * @param {string} id Aircraft id the layer should re-track.
 * @param {object} [opts] Rollback attribution.
 * @param {string} [opts.origin='programmatic'] Origin stamped on both the stop
 *   and the re-track so the change reads as one transaction.
 * @returns {boolean} Whether the layer accepted the tracked id.
 */
export function restoreAircraftTrackingOwner(layer, id, { origin = 'programmatic' } = {}) {
  if (!layer?.trackById || !id) return false;
  layer.stopTracking?.({ origin });
  return Boolean(layer.trackById(id, { origin }));
}

/**
 * Normalize Cockpit aircraft metadata into a stable tracking target.
 * @param {object} info Tracked-aircraft info from the owning layer.
 * @returns {{layerId: string, id: string}|null} Layer-scoped target, or null
 *   when the metadata names no layer or no aircraft.
 */
export function aircraftTrackingTarget(info) {
  if (!info?.layerId || !(info.icao24 || info.id)) return null;
  return {
    layerId: info.layerId,
    id: String(info.icao24 || info.id),
  };
}

/**
 * Enter Cockpit and restore the pre-transaction tracker after every failure form.
 *
 * @param {object} tx Entry transaction.
 * @param {object} tx.cockpitView Cockpit view controller (`enter`/`exit`/`readAircraftInfo`).
 * @param {object|null} [tx.selectedLayer] Layer owning an explicitly selected aircraft.
 * @param {{id: string}|null} [tx.selectedTarget] Aircraft the operator asked to follow in.
 * @param {object|null} [tx.currentLayer] Layer that owned tracking before entry.
 * @param {object|null} [tx.rollbackLayer] Layer to restore tracking on during rollback.
 * @param {{layerId: string, id: string}|undefined} [tx.rollbackTarget] Explicit
 *   restore target; omit to reuse the live tracked target read at entry.
 * @param {string} [tx.selectionOrigin='programmatic'] Origin attributed to the
 *   selection and to the rollback that undoes it.
 * @returns {{entered: boolean, error: string|null}} Entry outcome; `error` is a
 *   user-presentable message when entry failed.
 */
export function enterCockpitWithTracking({
  cockpitView,
  selectedLayer = null,
  selectedTarget = null,
  currentLayer = null,
  rollbackLayer = null,
  rollbackTarget = undefined,
  selectionOrigin = 'programmatic',
}) {
  const currentTarget = aircraftTrackingTarget(cockpitView?.readAircraftInfo?.());
  const restoreTarget = rollbackTarget === undefined ? currentTarget : rollbackTarget;
  const key = (target) => target?.layerId && target?.id
    ? `${target.layerId}:${target.id}`
    : null;
  let activeLayer = currentLayer;
  let activeTarget = currentTarget;
  let entryError = null;
  let entered = false;
  let entryThrew = false;

  try {
    const selectingTarget = Boolean(selectedLayer && selectedTarget?.id);
    if (selectingTarget) {
      activeLayer = selectedLayer;
      activeTarget = selectedTarget;
      if (!selectedLayer.trackById?.(selectedTarget.id, { origin: selectionOrigin })) {
        entryError = new Error('Selected aircraft could not be tracked for Cockpit entry');
      }
    }
    if (!entryError) entered = Boolean(cockpitView.enter());
  } catch (error) {
    entryThrew = true;
    entryError = error instanceof Error ? error : new Error(String(error));
  }

  if (!entered && key(activeTarget) !== key(restoreTarget)) {
    try {
      // Undo the explicit attempted selection through the same persistence
      // authority, then republish the prior target with that origin. A
      // programmatic rollback would fix the camera while leaving the failed
      // target durable in local/share state.
      activeLayer?.stopTracking?.({ origin: selectionOrigin });
      if (restoreTarget && !restoreAircraftTrackingOwner(
        rollbackLayer,
        restoreTarget.id,
        { origin: selectionOrigin },
      )) {
        entryError ||= new Error('Prior aircraft tracking could not be restored');
      }
    } catch (error) {
      entryError ||= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (entryThrew) {
    try {
      cockpitView.exit?.({ restoreTracking: false });
    } catch {
      // Tracker rollback above remains authoritative if partial Cockpit cleanup fails.
    }
  }

  return {
    entered,
    error: entered ? null : entryError?.message || 'Cockpit entry was unavailable',
  };
}
