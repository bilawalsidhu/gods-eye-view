import * as Cesium from 'cesium';
import {
  turnRateFromFixHistory,
  liftRepeatedGroundFix,
  synthesizeForwardKinematicsFix,
} from '../../data/motionModel.js';
import { POSITION_HISTORY_LIMIT } from './recordPolicy.js';

/** Apply military record changes to Cesium resources and existing follow operations. */
export function createMilitarySnapshotRenderer({
  flightState,
  records,
  groundFloor,
  meshFloor,
  militaryRegistry,
  rendering,
  tracking,
  icons,
  queries,
}) {
  const { warmGroundFloor, cachedGroundFloor, GROUND_FLOOR_LIFT_M } =
    groundFloor;
  const { sampleMeshFloorCells } = meshFloor;
  const { registerMilitaryIcaos } = militaryRegistry;
  return function applySnapshot(snapshot, viewer) {
    // Before init (or after destroy) there is no icon set to draw into.
    if (!flightState._icons) return { count: 0, ids: new Set() };
    const currentIcaos = new Set();
    const receiptNowMs = snapshot.observedAtMs;
    // Field-test fix (RS46): coarse floor cells to warm for the below-ground
    // clamp — collected during the loop (low airborne contacts only),
    // batch-resolved once after it. Never a fetch inside the loop.
    const _floorWarmPoints = [];

    for (const aircraft of snapshot.records) {
      const icao24 = aircraft.id;

      currentIcaos.add(icao24);
      const { prevMeta, meta, groundFlipped, fixEpochMs } = records.receive(
        aircraft,
        {
          observedAtMs: receiptNowMs,
          floorWarmPoints: _floorWarmPoints,
          modelOwnsVisual: aircraft.onGround
            ? rendering._modelOwnsVisual(icao24)
            : false,
        },
      );
      const position = Cesium.Cartesian3.fromDegrees(
        meta.rawLon,
        meta.rawLat,
        meta.renderAltitudeM,
      );
      if (groundFlipped) flightState._groundSnap.forget(icao24);
      const isTracked = icao24 === flightState._trackedIcao;

      // Append to position history stamped with the FEED's fix epoch.
      // adsb.lol's seen_pos is the AGE in seconds of the last position
      // report, so the fix epoch is receipt time minus that age. Only
      // append when the fix actually advances, so stale repeats don't
      // create zero-dt segments.
      const fixTime = Cesium.JulianDate.fromDate(new Date(fixEpochMs));
      if (!flightState._positionHistory.has(icao24)) {
        flightState._positionHistory.set(icao24, []);
      }
      const history = flightState._positionHistory.get(icao24);
      const newest = history[history.length - 1];
      if (!newest || Cesium.JulianDate.greaterThan(fixTime, newest.time)) {
        // Per-fix kinematics: the fix's own velocity/track ride along so the
        // extrapolation paths use the values that BELONG to the fix they
        // extend, not whatever the latest poll reported.
        history.push({
          time: fixTime,
          epochMs: fixEpochMs,
          position: position.clone(),
          velocity: meta.speedMps,
          track: meta.track,
        });
        if (history.length > POSITION_HISTORY_LIMIT) {
          history.shift();
        }
        // Turn rate from the fix-track history — computed once per new fix
        // (≤5 samples), consumed by the extrapolation paths at tick rate.
        meta.turnRateDps = turnRateFromFixHistory(history);
        // Trail accumulation is separate from the 5-fix DR history (PRD F2)
        // so the visible trail keeps growing while tracked. Round 2
        // (owner): ground traffic appends too — taxi history stays live
        // after touchdown; _appendTrailFix floors grounded positions at
        // the surface so the ground leg drapes instead of diving.
        if (isTracked) tracking._appendTrailFix(position.clone());
      } else {
        const modelOwnsGroundVisual = rendering._modelOwnsVisual(icao24);
        if (!modelOwnsGroundVisual) {
          liftRepeatedGroundFix(newest, position, meta.onGround);
        }
        const kinematicsChanged =
          newest.velocity !== meta.speedMps || newest.track !== meta.track;
        if (kinematicsChanged) {
          const synthetic = synthesizeForwardKinematicsFix(newest, {
            epochMs: Date.now(),
            velocity: meta.speedMps,
            track: meta.track,
            turnRateDps: meta.turnRateDps,
          });
          if (synthetic) {
            history.push(synthetic);
            if (history.length > POSITION_HISTORY_LIMIT) history.shift();
            meta.turnRateDps = turnRateFromFixHistory(history);
            if (isTracked) tracking._appendTrailFix(synthetic.position.clone());
          }
        }
      }

      if (flightState._icons.has(icao24)) {
        // Reclassification, a ground flip (a restyle, never a removal), a
        // freshness change and the cockpit contract all land on the row's
        // style; motion re-plans from the updated history.
        icons._applyIconPresentation(icao24);
        icons._planIcon(icao24);
        // Per-class GLBs: a class change can mean a different asset OR scale —
        // resync the live model, any in-flight load, and the tracked
        // standalone (mirror of flights.js).
        if (prevMeta?.klass !== meta.klass) rendering._syncModelToClass(icao24);
      } else {
        // Hidden while tracked: the tracked entity replaces it.
        icons._addIcon(icao24);
      }

      // Takeoff while TRACKED: ground traffic drew no trail, so start one
      // from the fresh airborne history (touchdown needs no action — the
      // append gate above simply freezes the existing trail).
      if (isTracked && groundFlipped && !meta.onGround)
        tracking._startTrail(icao24);

      // If this is the tracked aircraft, update label text
      // (position updates automatically via dead-reckoning CallbackProperty)
      if (isTracked && flightState._trackedEntity) {
        tracking._updateTrackedLabelModel(icao24);
      }
    }

    // Field-test fix (RS46): one batch warm of the low-airborne floor cells
    // collected above — fire-and-forget, single-flight, results read
    // synchronously by NEXT poll's clamp (same contract as flights.js's
    // grounded-surface warm).
    warmGroundFloor(_floorWarmPoints);
    // Round 6: re-floor STALE grounded contacts (mirror of flights.js) —
    // a parked contact whose feed went quiet froze at its pre-warm height.
    // The model-ownership gate matches the live grounded-clamp path (a
    // tileset-snapped model owns its visual; moving its icon would
    // disturb groundSnap's input — the T7 one-shot invariant).
    for (const [icao24, info] of flightState.records.data) {
      if (!info?.onGround || currentIcaos.has(icao24)) continue;
      if (rendering._modelOwnsVisual(icao24)) continue;
      if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon))
        continue;
      const floor = cachedGroundFloor(info.rawLat, info.rawLon);
      if (!Number.isFinite(floor)) continue;
      const lifted = floor + GROUND_FLOOR_LIFT_M;
      if (
        Number.isFinite(info.renderAltitudeM) &&
        info.renderAltitudeM >= floor - 1
      )
        continue;
      info.renderAltitudeM = lifted;
      const liftedPos = Cesium.Cartesian3.fromDegrees(
        info.rawLon,
        info.rawLat,
        lifted,
      );
      const hist = flightState._positionHistory.get(icao24);
      const newest = hist?.[hist.length - 1];
      if (newest)
        newest.position = Cesium.Cartesian3.clone(liftedPos, newest.position);
      if (flightState._icons.has(icao24)) {
        icons._applyIconPresentation(icao24);
        icons._planIcon(icao24);
      }
    }
    // Round 4: sample the RENDERED mesh for those cells (one-shot per cell,
    // budget-capped, viewer-proximate, google-3d regime only), excluding
    // this layer's own icons/models from the probe.
    {
      const viewerCarto =
        flightState._viewer?.camera?.positionCartographic || null;
      sampleMeshFloorCells(flightState._viewer?.scene, _floorWarmPoints, {
        excludeObjects: [
          ...icons._iconIds(),
          ...flightState._models.values(),
          flightState._trackedModel,
        ].filter(Boolean),
        viewerLat: viewerCarto
          ? Cesium.Math.toDegrees(viewerCarto.latitude)
          : undefined,
        viewerLon: viewerCarto
          ? Cesium.Math.toDegrees(viewerCarto.longitude)
          : undefined,
      });
    }

    // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
    // adsb.lol routinely drops aircraft for a single poll; immediate removal
    // made icons blink and yanked the camera off actively tracked flights.
    // EXCEPTION: likely-landed planes (last fix low + slow) get only
    // LANDED_MISSING_POLL_LIMIT — their disappearance means "landed", not a
    // feed gap, and the full grace left phantom planes parked at airports.
    const absentIds = [];
    for (let row = 0; row < flightState._icons.count; row++) {
      const icao24 = flightState._icons.idAt(row);
      if (!currentIcaos.has(icao24)) absentIds.push(icao24);
    }
    for (const icao24 of absentIds) {
      const absence = records.absence(icao24, {
        complete: snapshot.complete,
        retainIds: snapshot.retainIds,
        likelyLanded: queries._likelyLanded(icao24),
      });
      if (absence === 'retain') continue;
      if (absence === 'stale') {
        icons._applyIconPresentation(icao24); // the faded freshness alpha
        if (icao24 === flightState._trackedIcao && flightState._trackedEntity) {
          // Honest readout: the tracked plane has no faded icon (its
          // entity owns the visual), so refresh the label — with icao24 now
          // in _missingPolls, _buildTrackedLabel appends the STALE cue so
          // last-known altitude/speed aren't presented as live.
          tracking._updateTrackedLabelModel(icao24);
        }
        continue;
      }

      // If the tracked flight is truly gone, clear tracking BEFORE deleting
      // its state (M3 ordering, keep it): teardown reads the maps this loop
      // is about to delete (icon restore, DR cache reset), and we must
      // never leave the camera mid-follow with stale tracking state. The
      // camera is then RELEASED IN PLACE — it stays where the follow left
      // it, fully free (owner decision 2026-07-02: no overview flyTo).
      if (icao24 === flightState._trackedIcao) {
        tracking._clearTracking(false, { evicted: true });
      }

      icons._forgetContact(icao24); // aged out: its 3D model goes too (no orphan / cap leak)
    }

    // Feed the shared registry so the flights layer can classify/suppress
    registerMilitaryIcaos(currentIcaos);

    return { count: flightState._icons.count, ids: currentIcaos };
  };
}
