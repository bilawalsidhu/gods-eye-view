import * as Cesium from 'cesium';
import {
  FLOOR_REREAD_ATTEMPTS,
  FLOOR_REREAD_MS,
  FLOOR_WARM_PER_POLL,
  MODE_CESIUM_COLORS,
  OUTLINE_COLOR,
  POINT_PIXEL_SIZE,
  POINT_SCALE_BY_DISTANCE,
  SELECTED_CARD_REFRESH_MS,
  TRANSIT_LAYER_KEY,
} from './policy.js';
import {
  interpolatedVehiclePosition,
  vehicleHeightM,
  vehicleVisible,
} from './model.js';

/** Points, their ground anchoring, and the per-frame glide. */
export function createRendering({ state: layerState, services, parts }) {
  const { cachedGroundFloor, warmGroundFloor, GROUND_FLOOR_LIFT_M } =
    services.ground;

  function renderHeightM(entry) {
    const height = vehicleHeightM(entry.floorM, GROUND_FLOOR_LIFT_M);
    return height === null ? GROUND_FLOOR_LIFT_M : height;
  }

  function positionFor(lat, lon, entry, out) {
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      renderHeightM(entry),
      undefined,
      out,
    );
  }

  /** Read the shared floor for one vehicle; null while its cell is cold. */
  function readFloor(entry) {
    const floor = cachedGroundFloor(entry.to.lat, entry.to.lon);
    entry.floorM = Number.isFinite(floor) ? floor : null;
    return entry.floorM;
  }

  function applyVisibility(entry, nearGround) {
    entry.point.show = vehicleVisible(entry.floorM, nearGround);
  }

  function createVehicle(key, feedId, mode, record, now) {
    const entry = {
      key,
      feedId,
      mode,
      floorM: null,
      from: null,
      to: { lat: record.lat, lon: record.lon },
      tStart: now,
      tEnd: now,
      record,
      pollSeq: 0,
      point: null,
    };
    readFloor(entry);
    entry.point = layerState._points.add({
      id: key,
      position: positionFor(record.lat, record.lon, entry),
      color: MODE_CESIUM_COLORS[mode],
      pixelSize: POINT_PIXEL_SIZE,
      outlineColor: OUTLINE_COLOR,
      outlineWidth: 1,
      scaleByDistance: POINT_SCALE_BY_DISTANCE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    applyVisibility(entry, parts.viewport.nearGround());
    return entry;
  }

  function recolor(entry) {
    if (layerState._selectedKey !== entry.key)
      entry.point.color = MODE_CESIUM_COLORS[entry.mode];
  }

  function removeVehicle(key) {
    const entry = layerState._vehicles.get(key);
    if (!entry) return;
    if (layerState._selectedKey === key) parts.selection.clearSelection();
    if (layerState._points && entry.point)
      layerState._points.remove(entry.point);
    layerState._vehicles.delete(key);
  }

  function removeFeedVehicles(feedId) {
    for (const [key, entry] of layerState._vehicles)
      if (entry.feedId === feedId) removeVehicle(key);
  }

  /**
   * Anchor vehicles to the shared ground floor. Cold cells are warmed
   * (bounded per poll) and re-read on a short timer, never per frame. Far
   * from the ground the fleet renders at the ellipsoid and nothing is
   * warmed — a few metres of terrain are invisible from 60 km.
   */
  function anchorFloors() {
    if (layerState._floorTimer) {
      clearTimeout(layerState._floorTimer);
      layerState._floorTimer = null;
    }
    layerState._floorAttempts = 0;
    rereadFloors();
  }

  function rereadFloors() {
    layerState._floorTimer = null;
    if (!layerState._enabled || !layerState._points) return;
    const nearGround = parts.viewport.nearGround();
    const pending = [];
    for (const entry of layerState._vehicles.values()) {
      if (entry.floorM === null) {
        readFloor(entry);
        if (
          entry.floorM === null &&
          nearGround &&
          pending.length < FLOOR_WARM_PER_POLL
        )
          pending.push({ lat: entry.to.lat, lon: entry.to.lon });
        else if (entry.floorM !== null) {
          const drawn = interpolatedVehiclePosition(entry, layerState._now());
          entry.point.position = positionFor(drawn.lat, drawn.lon, entry);
        }
      }
      applyVisibility(entry, nearGround);
    }
    if (!pending.length) return;
    warmGroundFloor(pending);
    if (layerState._floorAttempts >= FLOOR_REREAD_ATTEMPTS) return;
    layerState._floorAttempts += 1;
    layerState._floorTimer = setTimeout(rereadFloors, FLOOR_REREAD_MS);
  }

  function syncRenderHold() {
    const shouldHold = layerState._enabled && layerState._vehicles.size > 0;
    if (shouldHold && !layerState._renderHeld) {
      services.render.holdContinuousRender(TRANSIT_LAYER_KEY);
      layerState._renderHeld = true;
    } else if (!shouldHold && layerState._renderHeld) {
      services.render.releaseContinuousRender(TRANSIT_LAYER_KEY);
      layerState._renderHeld = false;
    }
  }

  /** The glide: one lerp per vehicle per frame while a fix is in progress. */
  function advance(now = layerState._now()) {
    if (!layerState._enabled || layerState._vehicles.size === 0) return;
    for (const entry of layerState._vehicles.values()) {
      if (!entry.from || now >= entry.tEnd) {
        if (entry.from) {
          // Settle exactly on the fix once, then stop touching the primitive.
          entry.point.position = positionFor(
            entry.to.lat,
            entry.to.lon,
            entry,
            layerState._scratch,
          );
          entry.from = null;
        }
        continue;
      }
      const { lat, lon } = interpolatedVehiclePosition(entry, now);
      entry.point.position = positionFor(lat, lon, entry, layerState._scratch);
    }
    if (
      layerState._selectedKey &&
      now - layerState._selectedCardAt >= SELECTED_CARD_REFRESH_MS
    )
      parts.selection.refreshSelectedCard(false);
  }

  function onPreRender() {
    advance();
  }

  function clearFloorTimer() {
    if (layerState._floorTimer) clearTimeout(layerState._floorTimer);
    layerState._floorTimer = null;
    layerState._floorAttempts = 0;
  }

  return {
    createVehicle,
    recolor,
    removeVehicle,
    removeFeedVehicles,
    anchorFloors,
    rereadFloors,
    syncRenderHold,
    advance,
    onPreRender,
    clearFloorTimer,
  };
}
