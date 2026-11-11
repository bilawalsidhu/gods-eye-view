import * as geo from '../../geo/index.js';
import { cyberSonarBaseAlpha } from '../../cyberSonar.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  turnRateFromFixHistory,
  liftRepeatedGroundFix,
  staleHoldsForFix,
  synthesizeForwardKinematicsFix,
} from '../../data/motionModel.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { POSITION_HISTORY_LIMIT } from './recordPolicy.js';
import {
  BILLBOARD_SCALE,
  GROUND_SCALE,
  MIL_ICON_COLOR,
  TRACKED_ICON_COLOR,
  followsClock,
} from './policy.js';

/** Apply military record changes to the renderer's fleet and existing follow operations. */
export function createMilitarySnapshotRenderer({
  flightState,
  records,
  groundFloor,
  meshFloor,
  militaryRegistry,
  rendering,
  tracking,
  motion,
  queries,
}) {
  const { warmGroundFloor, cachedGroundFloor, GROUND_FLOOR_LIFT_M } =
    groundFloor;
  const { sampleMeshFloorCells } = meshFloor;
  const { registerMilitaryIcaos } = militaryRegistry;
  // A low contact is horizon-culled from 12 m up: its ground can lie below
  // the ellipsoid.
  function setCullPosition(id, meta) {
    flightState._cullPositions.set(
      id,
      meta.renderAltitudeM < 10
        ? geo.cartesian3.fromDegrees(meta.rawLon, meta.rawLat, 12)
        : null,
    );
  }

  function presentContact(icao24, meta, position, prevMeta, groundFlipped) {
    const isTracked = icao24 === flightState._trackedIcao;
    if (flightState._billboards.has(icao24)) {
      const bb = flightState._billboards.get(icao24);
      if (!isTracked) {
        bb.color = rendering
          ._fleetBillboardColor(icao24, meta)
          .withAlpha(cyberSonarBaseAlpha(bb));
      }
      // Position AND rotation are owned by the fleet pass (_fleetTick);
      // course changes land on the next rotation pass (forced below).
      // Ground flips (landing/takeoff) restyle this SAME billboard in
      // place — the transition is never a removal.
      if (
        prevMeta?.klass !== meta.klass ||
        groundFlipped ||
        flightState._cockpitContactMode
      ) {
        rendering._applyFleetBillboardPresentation(icao24, bb);
      }
      // Per-class GLBs: a class change can mean a different asset OR scale —
      // resync the live model, any in-flight load, and the tracked
      // standalone (mirror of flights.js).
      if (prevMeta?.klass !== meta.klass) rendering._syncModelToClass(icao24);
      // The depth policy is uniform (always depth-test-free, see
      // _groundDepthDistance) — nothing to flip on landing/takeoff.
    } else {
      // Start where the fleet pass will draw it: the fleet renders behind
      // real time, so a fresh contact's displayed position is its fix
      // projected back to that delayed time. Creating it at the raw fix drew
      // it ahead until the next fleet tick snapped it back.
      const displayed =
        motion._deadReckon(icao24, geo.cartesian3.create()) || position;
      const bb = flightState._renderer.fleet.add({
        position: displayed,
        image: aircraftIcon(rendering._iconKind(icao24, meta.klass)),
        width: isTracked ? 24 : 20,
        height: isTracked ? 24 : 20,
        scale:
          BILLBOARD_SCALE *
          (CLASS_SCALE_2D[meta.klass] || 1) *
          (meta.onGround ? GROUND_SCALE : 1),
        // Screen-projected rotation lands on the next fleet tick.
        rotation: 0,
        alignedAxis: geo.cartesian3.ZERO,
        color: isTracked ? TRACKED_ICON_COLOR : MIL_ICON_COLOR,
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
  }

  function presentRecords() {
    for (const [id, meta] of records.data) {
      const position = geo.cartesian3.fromDegrees(
        meta.rawLon,
        meta.rawLat,
        meta.renderAltitudeM,
      );
      setCullPosition(id, meta);
      presentContact(id, meta, position, null, false);
    }
  }

  function applySnapshot(snapshot, { replace = false } = {}) {
    const currentIcaos = new Set();
    const receiptNowMs = snapshot.observedAtMs;
    records.beginSnapshot(snapshot.observedAtMs);
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
      const position = geo.cartesian3.fromDegrees(
        meta.rawLon,
        meta.rawLat,
        meta.renderAltitudeM,
      );
      if (groundFlipped) flightState._groundSnap.forget(icao24);
      setCullPosition(icao24, meta);
      const isTracked = icao24 === flightState._trackedIcao;

      // Append to position history stamped with the FEED's fix epoch.
      // adsb.lol's seen_pos is the AGE in seconds of the last position
      // report, so the fix epoch is receipt time minus that age. Only
      // append when the fix actually advances, so stale repeats don't
      // create zero-dt segments.
      // Milliseconds since the epoch, whole as a Date holds them.
      const fixTimeMs = Math.trunc(fixEpochMs);
      if (!flightState._positionHistory.has(icao24)) {
        flightState._positionHistory.set(icao24, []);
      }
      const history = flightState._positionHistory.get(icao24);
      const newest = history[history.length - 1];
      if (!newest || fixTimeMs > newest.timeMs) {
        // Per-fix kinematics: the fix's own velocity/track ride along so the
        // extrapolation paths use the values that BELONG to the fix they
        // extend, not whatever the latest poll reported.
        history.push({
          timeMs: fixTimeMs,
          epochMs: fixEpochMs,
          position: geo.cartesian3.clone(position),
          velocity: meta.speedMps,
          track: meta.track,
          // Drawn at an invented height: a trail seeded from history keeps no
          // position for it.
          inventedHeight: meta.renderAltitudeInvented === true,
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
        if (isTracked)
          tracking._appendTrailFix(geo.cartesian3.clone(position), fixEpochMs, {
            nullAltitude: meta.renderAltitudeInvented === true,
          });
      } else {
        const modelOwnsGroundVisual = rendering._modelOwnsVisual(icao24);
        if (!modelOwnsGroundVisual) {
          liftRepeatedGroundFix(newest, position, meta.onGround);
        }
        // A forward synthetic fix follows the stale rules (none while the
        // contact holds at its report, a coast capped from the real report,
        // never below the ground) and is a motion aid, never a trail report.
        const kinematicsChanged =
          newest.velocity !== meta.speedMps || newest.track !== meta.track;
        const holds = staleHoldsForFix(newest, {
          onGround: meta.onGround,
          cachedGroundFloor,
        });
        if (kinematicsChanged && !holds) {
          const synthetic = synthesizeForwardKinematicsFix(newest, {
            // Following the clock, the snapshot's time is the moment it moves on from.
            epochMs: followsClock(flightState)
              ? snapshot.observedAtMs
              : Date.now(),
            velocity: meta.speedMps,
            track: meta.track,
            turnRateDps: meta.turnRateDps,
            cachedGroundFloor,
          });
          if (synthetic) {
            history.push(synthetic);
            if (history.length > POSITION_HISTORY_LIMIT) history.shift();
            meta.turnRateDps = turnRateFromFixHistory(history);
          }
        }
      }

      if (flightState._renderer)
        presentContact(icao24, meta, position, prevMeta, groundFlipped);
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
    // tileset-snapped model owns its visual; moving its billboard would
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
      flightState._cullPositions.delete(icao24);
      const liftedPos = geo.cartesian3.fromDegrees(
        info.rawLon,
        info.rawLat,
        lifted,
      );
      const hist = flightState._positionHistory.get(icao24);
      const newest = hist?.[hist.length - 1];
      if (newest)
        newest.position = geo.cartesian3.clone(liftedPos, newest.position);
      const bbStale = flightState._billboards.get(icao24);
      if (bbStale) bbStale.position = liftedPos;
    }
    // Round 4: sample the RENDERED mesh for those cells (a few probes per
    // cell, budget-capped, viewer-proximate, google-3d regime only), excluding
    // this layer's own billboards/models from the probe.
    if (flightState._renderer) {
      const viewerCarto =
        flightState._renderer?.view.camera?.positionCartographic || null;
      sampleMeshFloorCells(
        flightState._renderer?.view.engine,
        _floorWarmPoints,
        {
          excludeObjects:
            flightState._renderer?.surfaceExclusions({
              sprites: flightState._billboards.values(),
              models: [
                ...flightState._models.values(),
                flightState._trackedModel,
              ],
            }) ?? [],
          viewerLat: viewerCarto
            ? geo.math.toDegrees(viewerCarto.latitude)
            : undefined,
          viewerLon: viewerCarto
            ? geo.math.toDegrees(viewerCarto.longitude)
            : undefined,
        },
      );
    }

    // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
    // adsb.lol routinely drops aircraft for a single poll; immediate removal
    // made icons blink and yanked the camera off actively tracked flights.
    // EXCEPTION: likely-landed planes (last fix low + slow) get only
    // LANDED_MISSING_POLL_LIMIT — their disappearance means "landed", not a
    // feed gap, and the full grace left phantom planes parked at airports.
    for (const icao24 of records.data.keys()) {
      if (currentIcaos.has(icao24)) continue;
      const absence = replace
        ? 'remove'
        : records.absence(icao24, {
            complete: snapshot.complete,
            retainIds: snapshot.retainIds,
            likelyLanded: queries._likelyLanded(icao24),
            tracked: icao24 === flightState._trackedIcao,
            nowMs: flightState.now?.(),
          });
      if (absence === 'retain') continue;
      if (absence === 'stale') {
        if (icao24 === flightState._trackedIcao && flightState._trackedEntity) {
          // Honest readout: the tracked plane has no faded billboard (its
          // entity owns the visual), so refresh the label — with icao24 now
          // in _missingPolls, _buildTrackedLabel appends the STALE cue so
          // last-known altitude/speed aren't presented as live.
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

      const bb = flightState._billboards.get(icao24);
      if (bb) flightState._renderer.fleet.remove(bb);
      flightState._billboards.delete(icao24);
      rendering._releaseModel(icao24); // aged-out aircraft: drop its 3D model (no orphan / cap leak)
      records.forget(icao24);
      flightState._cullPositions.delete(icao24);
      flightState._positionHistory.delete(icao24);
      flightState._displayCourse.delete(icao24);
      flightState._groundSnap.forget(icao24);
    }

    // The tracked contact at the new time: its trail starts there.
    if (
      replace &&
      flightState._trackedIcao &&
      currentIcaos.has(flightState._trackedIcao)
    )
      tracking._startTrail(flightState._trackedIcao);

    // Fresh courses arrived — force a rotation pass on the next fleet tick
    flightState._lastCamPoseSig = '';

    // Feed the shared registry so the flights layer can classify/suppress
    registerMilitaryIcaos(currentIcaos);

    return { count: records.data.size, ids: currentIcaos };
  }
  return { applySnapshot, presentRecords };
}
