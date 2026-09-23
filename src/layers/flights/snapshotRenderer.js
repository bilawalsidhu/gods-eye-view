import * as Cesium from 'cesium';
import {
  turnRateFromFixHistory,
  liftRepeatedGroundFix,
  synthesizeForwardKinematicsFix,
} from '../../data/motionModel.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { POSITION_HISTORY_LIMIT } from './recordPolicy.js';

/** Apply reconciled aircraft records to Cesium resources and follow state. */
export function createFlightSnapshotRenderer({
  flightState,
  records,
  militaryRegistry,
  groundFloor,
  meshFloor,
  rendering,
  tracking,
  motion,
  enrichment,
  queries,
}) {
  const { refreshMilitaryRegistryIfStale, isMilitaryIcao } = militaryRegistry;
  const { warmGroundFloor } = groundFloor;
  const { sampleMeshFloorCells } = meshFloor;
  return function applySnapshot(snapshot, viewer) {
    const currentIcaos = new Set();
    const acceptedSnapshotIcaos = new Set();
    // Field-test round 3 (2026-07-06, Austin fleet-underground): viewer
    // subpoint + collected floor cells for the viewer-proximate low-contact
    // clamp below — one carto read per poll, one batch warm after the loop.
    const viewerCarto =
      (viewer || flightState._viewer)?.camera?.positionCartographic || null;
    const viewerLatDeg = viewerCarto
      ? Cesium.Math.toDegrees(viewerCarto.latitude)
      : null;
    const viewerLonDeg = viewerCarto
      ? Cesium.Math.toDegrees(viewerCarto.longitude)
      : null;
    const floorWarmPoints = [];

    // Classification and display policy consume source-independent observations.
    refreshMilitaryRegistryIfStale();
    for (const observation of snapshot.records) {
      const icao24 = observation.id;
      acceptedSnapshotIcaos.add(icao24);

      // Known-military aircraft: the dedicated military layer wins
      // (icon + track + click) while it is enabled — suppress the
      // OpenSky duplicate entirely (except a currently tracked one,
      // which hands off on untrack).
      const isMil = isMilitaryIcao(icao24);
      if (isMil && tracking._militaryLayerSuppresses(icao24)) {
        const dupe = flightState._billboards.get(icao24);
        if (dupe) {
          flightState._billboardCollection.remove(dupe);
          flightState._billboards.delete(icao24);
          rendering._releaseModel(icao24); // military-suppression: drop any 3D model too
          records.forget(icao24);
          flightState._cullPositions.delete(icao24);
          flightState._positionHistory.delete(icao24);
          flightState._displayCourse.delete(icao24);
          flightState._groundSnap.forget(icao24);
        }
        continue;
      }

      currentIcaos.add(icao24);
      const { prevMeta, meta, groundFlipped, fixEpochMs } = records.receive(
        observation,
        {
          viewerLatDeg,
          viewerLonDeg,
          trackedId: flightState._trackedIcao,
          floorWarmPoints,
        },
      );
      const position = Cesium.Cartesian3.fromDegrees(
        meta.rawLon,
        meta.rawLat,
        meta.renderAltitudeM,
      );
      // Either flip retires the previous one-shot ground sample.
      if (groundFlipped) flightState._groundSnap.forget(icao24);
      flightState._cullPositions.set(
        icao24,
        meta.renderAltitudeM < 10
          ? Cesium.Cartesian3.fromDegrees(meta.rawLon, meta.rawLat, 12)
          : null,
      );
      const isTracked = icao24 === flightState._trackedIcao;

      // Append to position history stamped with the FEED's fix epoch
      // (time_position), not client receipt time — OpenSky positions arrive
      // 5-15s stale and receipt-time stamping is what caused the
      // back/forward oscillation. Only append when the fix actually
      // advances, so stale repeats don't create zero-dt segments.
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
          velocity: meta.velocity,
          track: meta.true_track,
        });
        if (history.length > POSITION_HISTORY_LIMIT) {
          history.shift();
        }
        // Turn rate from the fix-track history — computed once per new fix
        // (≤5 samples), consumed by the extrapolation paths at tick rate.
        meta.turnRateDps = turnRateFromFixHistory(history);
        // Trail accumulation is separate from the 5-fix DR history (PRD F1)
        // so the visible trail keeps growing while tracked. Ground traffic
        // appends nothing — a touchdown freezes the existing trail.
        // Round 2 (owner): ground traffic appends too — taxi history stays
        // live after touchdown (grounded flights positions are already
        // surface-clamped via the surfaceM chain, so the ground leg drapes).
        if (isTracked) tracking._appendTrailFix(position.clone());
      } else {
        const modelOwnsGroundVisual = rendering._modelOwnsVisual(icao24);
        if (!modelOwnsGroundVisual) {
          liftRepeatedGroundFix(newest, position, meta.onGround);
        }
        // Apply fresh kinematics only from a forward synthetic fix. Mutating
        // the historical fix reprojects the entire stale interval and snaps
        // the rendered aircraft when course or speed changes late.
        const kinematicsChanged =
          newest.velocity !== meta.velocity || newest.track !== meta.true_track;
        if (kinematicsChanged) {
          const synthetic = synthesizeForwardKinematicsFix(newest, {
            epochMs: Date.now(),
            velocity: meta.velocity,
            track: meta.true_track,
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

      if (flightState._billboards.has(icao24)) {
        const bb = flightState._billboards.get(icao24);
        // Reclassify if the category resolved/changed (first extended poll);
        // a ground flip (landing/takeoff) re-scales the SAME billboard in
        // place — the transition is a restyle, never a removal.
        // Round 5: depth policy is uniform (always depth-test-free, see
        // _groundDepthDistance) — nothing to flip on landing/takeoff.
        // Position AND rotation are owned by the fleet pass (_fleetTick);
        // course changes land on the next rotation pass (forced below).
        if (!isTracked) {
          // Refresh affiliation hue without clobbering the tick-owned
          // freshness × focus × horizon alpha composition.
          bb.color = rendering
            ._fleetBillboardColor(icao24)
            .withAlpha(bb.color?.alpha ?? 1);
        }
        if (
          prevMeta?.klass !== meta.klass ||
          groundFlipped ||
          flightState._cockpitContactMode
        ) {
          rendering._applyFleetBillboardPresentation(icao24, bb);
        }
        // Poll-path class change (category updates): same model resync rule
        // as the enrichment path — the class's GLB/scale may have changed.
        if (prevMeta?.klass !== meta.klass) rendering._syncModelToClass(icao24);
      } else {
        const bb = flightState._billboardCollection.add({
          position,
          image: aircraftIcon(rendering._iconKind(icao24, meta.klass)),
          width: isTracked ? 24 : 20,
          height: isTracked ? 24 : 20,
          scale: rendering._fleetBillboardScale(icao24, meta.klass),
          // Screen-projected rotation lands on the next fleet tick.
          rotation: 0,
          alignedAxis: Cesium.Cartesian3.ZERO,
          color: isTracked
            ? Cesium.Color.CYAN
            : rendering._fleetBillboardColor(icao24),
          sizeInMeters: false,
          scaleByDistance: rendering._normalBillboardScaleByDistance(),
          // Grounded/near-surface planes sit at/below the photoreal tile
          // surface — render them depth-test-free so they never vanish up
          // close (_groundDepthDistance).
          disableDepthTestDistance: rendering._groundDepthDistance(),
          id: icao24,
          show: !isTracked, // hidden if currently tracked (entity replaces it)
        });
        flightState._billboards.set(icao24, bb);
        rendering._applyFleetBillboardPresentation(icao24, bb);
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

    // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
    // OpenSky routinely drops aircraft for a single poll; immediate removal
    // made planes blink and yanked the camera off actively tracked flights.
    // EXCEPTION: likely-landed planes (last fix low + slow) get only
    // LANDED_MISSING_POLL_LIMIT — their disappearance means "landed", not a
    // feed gap, and the full grace left phantom planes parked at airports.
    for (const [icao24, bb] of flightState._billboards) {
      if (currentIcaos.has(icao24)) continue;
      const absence = records.absence(icao24, {
        complete: snapshot.complete,
        likelyLanded: queries._likelyLanded(icao24),
      });
      if (absence === 'retain') continue;
      if (absence === 'stale') {
        if (icao24 === flightState._trackedIcao && flightState._trackedEntity) {
          // Honest readout: the tracked plane has no faded billboard (its
          // entity owns the visual), so refresh the label — with icao24 now
          // in _missingPolls, _trackedLabelText appends the STALE cue so
          // last-known velocity/altitude aren't presented as live.
          tracking._updateTrackedLabelModel(icao24);
        }
        continue;
      }

      // If the tracked flight is truly gone, clear tracking BEFORE deleting
      // its state (M3 ordering, keep it): teardown reads the maps this loop
      // is about to delete (billboard restore, DR cache reset), and we must
      // never leave the camera mid-follow with stale tracking state. The
      // camera is then RELEASED IN PLACE — it stays where the follow left
      // it, fully free (owner decision 2026-07-02: no overview flyTo).
      if (icao24 === flightState._trackedIcao) {
        tracking._clearTracking(false, { evicted: true });
      }

      flightState._billboardCollection.remove(bb);
      flightState._billboards.delete(icao24);
      rendering._releaseModel(icao24); // aged-out aircraft: drop its 3D model (no orphan / cap leak)
      records.forget(icao24);
      flightState._cullPositions.delete(icao24);
      flightState._positionHistory.delete(icao24);
      flightState._displayCourse.delete(icao24);
      flightState._groundSnap.forget(icao24);
      flightState._displayFloorState.delete(icao24);
    }

    // Fresh courses arrived — force a rotation pass on the next fleet tick
    flightState._lastCamPoseSig = '';

    // Ambient type enrichment: give ON-SCREEN planes real types (bounded
    // sweep — see _sweepAmbientEnrichment; internally fail-silent).
    enrichment._sweepAmbientEnrichment();

    // 2026-08-19: the loop above only ever collects FIX cells, but a grounded
    // contact renders across every cell its dead-reckoned position drifts
    // through. Add those too, so the display clamp has data where the contact
    // actually is instead of silently passing.
    motion._collectDisplayCorridorCells(
      floorWarmPoints,
      viewerLatDeg,
      viewerLonDeg,
    );

    // Field-test round 3: one batch warm of the viewer-proximate low-contact
    // floor cells collected in the loop (fire-and-forget, single-flight;
    // read synchronously by NEXT poll's clamp — the military-layer pattern).
    warmGroundFloor(floorWarmPoints);
    // Round 4: sample the RENDERED mesh for those same cells (one-shot per
    // cell, budget-capped, viewer-proximate, google-3d regime only). Own
    // billboards/models are excluded so a vertical probe can't land on an
    // aircraft instead of the pavement.
    sampleMeshFloorCells(flightState._viewer?.scene, floorWarmPoints, {
      excludeObjects: [
        ...flightState._billboards.values(),
        ...flightState._models.values(),
        flightState._trackedModel,
      ].filter(Boolean),
      viewerLat: viewerLatDeg,
      viewerLon: viewerLonDeg,
    });

    // Round 5: the grounded exact-key warm that used to live here is gone —
    // see the note where _warmGroundedAircraftSurfaceCache was removed. The
    // viewer-proximate coarse warm + mesh sampler above cover everything
    // whose height is actually visible.
    // Round 6: re-floor STALE grounded contacts. A parked plane whose
    // transponder went quiet stops receiving poll updates, so a floor that
    // warms AFTER its last fix never applied — it sat frozen at the geoid
    // (ATL verify: FFT4347 at −30.7 m, 305 m under the apron, forever).
    // Grounded contacts are static, so lifting the stored fix + billboard
    // in place is safe (the DR extrapolates a zero-velocity fix).
    motion._refloorStaleGroundedContacts(currentIcaos);

    return { count: flightState._billboards.size, ids: acceptedSnapshotIcaos };
  };
}
