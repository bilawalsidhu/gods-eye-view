import * as Cesium from 'cesium';
import { PARTIAL_RETENTION_MS } from './policy.js';
import { SELECTED_PIN_REFRESHES, VESSEL_LIFT_M } from './policy.js';

export function createStore({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;

  /**
   * Reconcile the incoming AIS rows against the MMSI-keyed record map.
   * Existing records are updated in place (position/heading/label) so identity
   * and selection survive refreshes; new vessels are added; vanished vessels are
   * removed — except the selected vessel, which is pinned for up to
   * SELECTED_PIN_REFRESHES consecutive misses with a stale HUD readout.
   * Rows without an MMSI are rendered unkeyed and rebuilt fresh each refresh.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
   * @param {Array<Object>} rows - Raw AIS rows from the live API.
   */

  function reconcileVessels(viewer, rows, { complete = true } = {}) {
    const receivedAtMs = vesselState._aisRuntime.now();
    components.rendering.ensureCollections(viewer);

    // Unkeyed (no-MMSI) records cannot be diffed — drop and rebuild them.
    for (const record of state.unkeyedRecords) {
      components.rendering.removeRecordPrimitives(record);
    }
    state.unkeyedRecords = [];

    const occluder = components.rendering.makeOccluder();
    const seen = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const next = normalizeVessel(rows[index]);
      if (!next) continue;
      next.receivedAtMs = receivedAtMs;

      if (!next.mmsi) {
        components.rendering.addRecordPrimitives(next, occluder);
        state.unkeyedRecords.push(next);
        continue;
      }
      if (seen.has(next.mmsi)) continue; // defensive: dedupe payload rows
      seen.add(next.mmsi);

      const existing = state.vesselMap.get(next.mmsi);
      if (existing) {
        updateRecordInPlace(existing, next);
      } else {
        components.rendering.addRecordPrimitives(next, occluder);
        state.vesselMap.set(next.mmsi, next);
      }
    }

    // Remove vanished vessels, pinning the selected one for a few refreshes.
    for (const [mmsi, record] of state.vesselMap) {
      if (seen.has(mmsi)) continue;
      if (
        !complete &&
        Number.isFinite(record.receivedAtMs) &&
        receivedAtMs - record.receivedAtMs < PARTIAL_RETENTION_MS
      ) {
        if (record === state.selectedRecord) {
          record.missedRefreshes = Math.max(1, record.missedRefreshes || 0);
          components.cards.updateSelectedVesselHud(record);
        }
        continue;
      }
      if (record === state.selectedRecord) {
        record.missedRefreshes = (record.missedRefreshes || 0) + 1;
        if (complete && record.missedRefreshes <= SELECTED_PIN_REFRESHES) {
          components.cards.updateSelectedVesselHud(record); // re-render with STALE marker
          continue;
        }
        // Aged out of the feed after exhausting its pin — not a deselect.
        components.selection.clearVesselInspection({ evicted: true });
      }
      components.rendering.removeRecordPrimitives(record);
      state.vesselMap.delete(mmsi);
      // Defensive lifecycle closure: a trail may outlive selection state during
      // asynchronous handoff/refresh ordering, but never its owning record.
      if (state.trailMmsi === mmsi)
        components.tracking.clearSelectedVesselTrail();
    }

    const cap = components.rendering.renderRowLimit();
    if (state.vesselMap.size + state.unkeyedRecords.length > cap) {
      for (const [mmsi, record] of state.vesselMap) {
        if (state.vesselMap.size + state.unkeyedRecords.length <= cap) break;
        if (seen.has(mmsi) || record === state.selectedRecord) continue;
        components.rendering.removeRecordPrimitives(record);
        state.vesselMap.delete(mmsi);
        if (state.trailMmsi === mmsi)
          components.tracking.clearSelectedVesselTrail();
      }
    }
    state.vesselRecords = [
      ...state.vesselMap.values(),
      ...state.unkeyedRecords,
    ];
    state.lastVisibilityUpdate = 0;
    components.rendering.updateVisibility(true);
  }

  /**
   * Update an existing record (and its primitives) from a freshly normalized row,
   * preserving object identity so selection and the click-pick id stay valid.
   * Billboard image is only reassigned when the resolved icon actually changes
   * (type recolor) to avoid thousands of redundant texture lookups per refresh.
   * @param {Object} record - Existing vessel record in state.vesselMap.
   * @param {Object} next - Freshly normalized record for the same MMSI.
   */

  function updateRecordInPlace(record, next) {
    const selected = record === state.selectedRecord;
    const prevIcon = components.rendering.shipIcon(record, selected);

    record.reference = next.reference;
    record.receivedAtMs = next.receivedAtMs;
    record.lat = next.lat;
    record.lon = next.lon;
    record.name = next.name;
    record.imo = next.imo;
    record.type = next.type;
    record.destination = next.destination;
    record.speed = next.speed;
    record.course = next.course;
    record.heading = next.heading;
    record.lastPositionUtc = next.lastPositionUtc;
    record.lastPositionEpoch = next.lastPositionEpoch;
    record.position = next.position;
    record.surfacePosition = next.surfacePosition;
    record.normal = next.normal;
    record.missedRefreshes = 0;

    if (record.billboard) {
      record.billboard.position = record.position;
      // Rotation is owned by the projected-rotation pass (updateVisibility).
      record.billboard.scale =
        components.rendering.shipScale(record) * (selected ? 1.2 : 1);
      const nextIcon = components.rendering.shipIcon(record, selected);
      if (nextIcon !== prevIcon) {
        record.billboard.image = nextIcon;
      }
    }
    if (record.mmsi === state.trailMmsi) {
      components.tracking.appendSelectedVesselTrailFix(record);
    }
    if (selected) {
      components.cards.updateSelectedVesselHud(record);
      components.selection.registerSelectedContext(record);
    }
  }

  function normalizeVessel(row) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Vertical datum: anchor at the SEA SURFACE (geoid, h = N + lift), not the
    // ellipsoid — at height 0 everything that projects record.position (clicks,
    // detection brackets, cards, getNearby) points up to ~45 m under the water.
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(lat, lon),
      VESSEL_LIFT_M,
    );
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, heightM);
    // Surface normal at this position — used as alignedAxis so billboard
    // rotation operates in the local tangent plane (true world heading)
    const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      position,
      new Cesium.Cartesian3(),
    );
    return {
      lat,
      lon,
      name: String(row.name || row.mmsi || 'VESSEL'),
      mmsi: String(row.mmsi || '').trim(),
      reference: row.reference ?? String(row.mmsi || '').trim(),
      imo: String(row.imo || ''),
      type: String(row.type || ''),
      destination: String(row.destination || ''),
      speed: finiteNumber(row.speed),
      course: finiteNumber(row.course),
      heading: finiteNumber(row.heading),
      lastPositionUtc: String(row.last_position_UTC || ''),
      lastPositionEpoch: finiteNumber(row.last_position_epoch),
      position,
      // Ellipsoid-surface point (height 0) — feeds ONLY the horizon occluder,
      // which tests against the WGS84 ellipsoid; keep it off the sea datum.
      surfacePosition: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      normal,
      missedRefreshes: 0,
      billboard: null,
    };
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return {
    reconcileVessels,
    updateRecordInPlace,
    normalizeVessel,
    finiteNumber,
  };
}
