import * as Cesium from 'cesium';
import { FOCUS_EVIDENCE_DEV } from './policy.js';

export function createEvidence({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;

  /** Replace live AIS rows through the production reconciliation path (DEV only). */

  function _setFocusEvidenceVessels(rows = []) {
    if (!FOCUS_EVIDENCE_DEV || !state.viewer || !state.billboardCollection) {
      return { ok: false, count: 0 };
    }
    components.selection.clearVesselInspection();
    components.store.reconcileVessels(
      state.viewer,
      Array.isArray(rows) ? rows : [],
    );
    state.count = state.vesselRecords.length;
    state.loaded = true;
    state.error = null;
    state.stale = false;
    state.lastUpdate = Date.now();
    state.transportStatus = 'synthetic';
    state.lastMessageAt = null;
    state.rawRowCount = Array.isArray(rows) ? rows.length : 0;
    state.acceptedRowCount = state.count;
    return { ok: true, count: state.count };
  }

  /** JSON-safe vessel alpha/position snapshot for the evidence report. */

  function _focusEvidenceVesselSnapshot() {
    if (!FOCUS_EVIDENCE_DEV || !state.viewer) return [];
    return state.vesselRecords.map((record) => {
      const bb = record.billboard;
      const screen = bb?.position
        ? Cesium.SceneTransforms.worldToWindowCoordinates(
            state.viewer.scene,
            bb.position,
          )
        : null;
      return {
        id: record.mmsi,
        show: bb?.show === true,
        alpha: bb?.color?.alpha ?? null,
        x: screen?.x ?? null,
        y: screen?.y ?? null,
      };
    });
  }
  return { _setFocusEvidenceVessels, _focusEvidenceVesselSnapshot };
}
