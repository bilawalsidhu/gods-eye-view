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
    components.snapshots.reconcileVessels(
      state.viewer,
      Array.isArray(rows) ? rows : [],
    );
    state.feed.count = state.records.all.length;
    state.feed.loaded = true;
    state.feed.error = null;
    state.feed.stale = false;
    state.feed.partial = false;
    state.feed.lastUpdate = Date.now();
    state.feed.transportStatus = 'synthetic';
    state.feed.lastMessageAt = null;
    state.feed.rawRowCount = Array.isArray(rows) ? rows.length : 0;
    state.feed.acceptedRowCount = state.feed.count;
    return { ok: true, count: state.feed.count };
  }

  /** JSON-safe vessel alpha/position snapshot for the evidence report. */

  function _focusEvidenceVesselSnapshot() {
    if (!FOCUS_EVIDENCE_DEV || !state.viewer) return [];
    return state.records.all.map((record) => {
      const bb = components.rendering.getVisual(record).billboard;
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
