import { findCamera } from '../../render/rendererOf.js';
import {
  turnRateFromFixHistory,
  liftRepeatedGroundFix,
  staleHoldsForFix,
  synthesizeForwardKinematicsFix,
} from '../../data/motionModel.js';
import { POSITION_HISTORY_LIMIT } from './recordPolicy.js';
import { followsClock } from './policy.js';
import { newestReport, pushReport } from '../../data/aircraftMotionRegime.js';
import { observeLiveAircraft } from './placed.js';
import {
  historyAfterTrail,
  mergeAircraftTimelineFixes,
} from '../../data/timelineHistory.js';

/**
 * Note how late each report in a live snapshot is, and aim the display delay
 * again, before any contact is planned with it: a layer drawing nothing yet
 * takes the new delay at once.
 */
function noteDelivery(flightState, snapshot) {
  const delay = flightState._displayDelay;
  if (!delay) return;
  const receiptMs = Date.now();
  for (const observation of snapshot.records) {
    const reportMs = observation.positionTimeMs;
    if (!(Number.isFinite(reportMs) && reportMs > 0)) continue;
    const history = flightState._positionHistory.get(observation.id);
    const previous = history && newestReport(history);
    delay.noteReport(
      receiptMs,
      reportMs,
      previous ? Math.trunc(previous.epochMs) : undefined,
    );
  }
  delay.settle(receiptMs, { jump: !flightState._icons.count });
}

/** Apply reconciled aircraft records to the layer's drawing and follow state. */
export function createFlightSnapshotRenderer({
  flightState,
  placement = null,
  records,
  militaryRegistry,
  groundFloor,
  rendering,
  tracking,
  motion,
  icons,
  enrichment,
  queries,
}) {
  const { refreshMilitaryRegistryIfStale, isMilitaryIcao } = militaryRegistry;
  const { warmGroundFloor, cachedGroundFloor } = groundFloor;
  /**
   * `replace`: the snapshot is the world at another time (the world clock
   * jumped), so it stands in for every contact: one it lacks is gone at once.
   * `handover`: the first live snapshot after the clock came back to live: it
   * stands in for every contact too, and those it has keep their icon and
   * model and ease on from where they are drawn; of those it lacks, only
   * those absence keeps (judged by their newest fix) stay.
   */
  return function applySnapshot(
    snapshot,
    viewer,
    { replace = false, handover = false } = {},
  ) {
    // Before init (or after destroy) there is no icon set to draw into.
    if (!flightState._icons) return { count: 0, ids: new Set() };
    const currentIcaos = new Set();
    const acceptedSnapshotIcaos = new Set();
    // Field-test round 3 (2026-07-06, Austin fleet-underground): viewer
    // subpoint + collected floor cells for the viewer-proximate low-contact
    // clamp below — one carto read per poll, one batch warm after the loop.
    const pose = findCamera(viewer || flightState._viewer)?.pose() ?? null;
    const hasSubpoint =
      Number.isFinite(pose?.lat) && Number.isFinite(pose?.lon);
    const viewerLatDeg = hasSubpoint ? pose.lat : null;
    const viewerLonDeg = hasSubpoint ? pose.lon : null;
    const floorWarmPoints = [];
    records.beginSnapshot(snapshot.observedAtMs);
    // Live, the display delay follows how late this delivery's reports are.
    if (!replace && !followsClock(flightState))
      noteDelivery(flightState, snapshot);

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
        // Military-suppression: drop the duplicate with any 3D model too.
        if (flightState._icons.has(icao24)) icons._forgetContact(icao24);
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
      const position = motion._fixPosition(
        meta.rawLon,
        meta.rawLat,
        meta.renderAltitudeM,
      );
      // Either flip retires the previous one-shot ground sample.
      if (groundFlipped) flightState._groundSnap.forget(icao24);
      if (meta.onGround) {
        flightState._grounded.add(icao24);
      } else if (flightState._grounded.delete(icao24)) {
        flightState._floorPinned.delete(icao24);
        motion._retireDisplayFloorState(icao24, Date.now());
      }
      const isTracked = icao24 === flightState._trackedIcao;

      // Following the clock, a record may carry its own track around the
      // time: the contact is placed on it, so the clock can move within it,
      // back as well as on, without another snapshot.
      const timelineHistory = followsClock(flightState)
        ? mergeAircraftTimelineFixes(
            flightState._positionHistory.get(icao24),
            observation,
            meta,
            meta.velocity,
            snapshot.observedAtMs ?? fixEpochMs,
          )
        : null;
      // A host-supplied placement, if any, is told every fix as taken.
      observeLiveAircraft(
        flightState,
        placement,
        icao24,
        fixEpochMs,
        meta,
        meta.velocity,
        meta.true_track,
      );
      if (timelineHistory) {
        if (isTracked)
          for (const entry of historyAfterTrail(
            timelineHistory,
            flightState._trailFixes,
            snapshot.observedAtMs ?? fixEpochMs,
          ))
            tracking._appendTrailFix(
              motion._copyPosition(entry.position),
              entry.epochMs,
              { nullAltitude: entry.inventedHeight, track: entry.track },
            );
        flightState._positionHistory.set(icao24, timelineHistory);
        meta.turnRateDps = 0;
      } else {
        // Append to position history stamped with the FEED's fix epoch
        // (time_position), not client receipt time — OpenSky positions arrive
        // 5-15s stale and receipt-time stamping is what caused the
        // back/forward oscillation. Only append when the fix actually
        // advances, so stale repeats don't create zero-dt segments.
        if (!flightState._positionHistory.has(icao24)) {
          flightState._positionHistory.set(icao24, []);
        }
        const history = flightState._positionHistory.get(icao24);
        const newest = history[history.length - 1];
        const report = newestReport(history);
        // Whole milliseconds, as the fix times are kept. A report newer than
        // the last report goes in, past any synthetic fix after it.
        if (
          !report ||
          Math.trunc(fixEpochMs) > Math.trunc(motion._fixEpochMs(report))
        ) {
          // Per-fix kinematics: the fix's own velocity/track ride along so the
          // extrapolation paths use the values that BELONG to the fix they
          // extend, not whatever the latest poll reported.
          pushReport(
            history,
            {
              ...motion._historyFix(
                fixEpochMs,
                position,
                meta.velocity,
                meta.true_track,
              ),
              // Drawn at an invented height: a trail seeded from history keeps no
              // position for it.
              inventedHeight: meta.renderAltitudeInvented === true,
              // Whether this report was on the ground: a trail backfill joins it
              // only across a landing or take-off it saw.
              onGround: meta.onGround === true,
            },
            POSITION_HISTORY_LIMIT,
          );
          // Turn rate from the fix-track history — computed once per new fix
          // (≤5 samples), consumed by the extrapolation paths at tick rate.
          meta.turnRateDps = turnRateFromFixHistory(history.slice(-5));
          // Trail accumulation is separate from the 5-fix DR history (PRD F1)
          // so the visible trail keeps growing while tracked. Ground traffic
          // appends nothing — a touchdown freezes the existing trail.
          // Round 2 (owner): ground traffic appends too — taxi history stays
          // live after touchdown (grounded flights positions are already
          // surface-clamped via the surfaceM chain, so the ground leg drapes).
          if (isTracked)
            tracking._appendTrailFix(
              motion._copyPosition(position),
              fixEpochMs,
              {
                nullAltitude: meta.renderAltitudeInvented === true,
                track: meta.true_track,
                estimated: meta.estimated === true,
              },
            );
        } else {
          const modelOwnsGroundVisual = rendering._modelOwnsVisual(icao24);
          if (!modelOwnsGroundVisual) {
            liftRepeatedGroundFix(newest, position, meta.onGround);
          }
          // Apply fresh kinematics only from a forward synthetic fix. Mutating
          // the historical fix reprojects the entire stale interval and snaps
          // the rendered aircraft when course or speed changes late. The stale
          // rules apply: none for a contact that holds at its report, a coast
          // capped from the real report, never below the ground. It is a motion
          // aid, not a report, so it never joins the trail.
          const kinematicsChanged =
            newest.velocity !== meta.velocity ||
            newest.track !== meta.true_track;
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
              velocity: meta.velocity,
              track: meta.true_track,
              turnRateDps: meta.turnRateDps,
              cachedGroundFloor,
            });
            if (synthetic) {
              history.push(synthetic);
              if (history.length > POSITION_HISTORY_LIMIT) history.shift();
              meta.turnRateDps = turnRateFromFixHistory(history.slice(-5));
            }
          }
        }
      }

      if (flightState._icons.has(icao24)) {
        // Reclassification, a ground flip (a restyle, never a removal), a
        // freshness change and the cockpit contract all land on the row's
        // style; motion re-plans from the updated history.
        icons._applyIconPresentation(icao24);
        icons._planIcon(icao24, handover ? { handover } : undefined);
        // Poll-path type or category change: same model resync rule as the
        // enrichment path — the fleet model or its scale may have changed.
        if (
          prevMeta?.klass !== meta.klass ||
          prevMeta?.category !== meta.category ||
          prevMeta?.typeCode !== meta.typeCode
        )
          rendering._syncModelToClass(icao24);
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
        // Re-ask the tracked plane's lookups each poll. Answered and queued
        // keys return at once; a lookup whose source failed runs again once
        // its cool-down has passed, and the route uses the callsign this
        // snapshot just recorded.
        enrichment._requestTypeEnrichment(icao24, true);
        enrichment._requestRouteEnrichment(icao24);
        enrichment._requestPhotoEnrichment(icao24);
      }
    }

    // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
    // OpenSky routinely drops aircraft for a single poll; immediate removal
    // made planes blink and yanked the camera off actively tracked flights.
    // EXCEPTION: likely-landed planes (last fix low + slow) get only
    // LANDED_MISSING_POLL_LIMIT — their disappearance means "landed", not a
    // feed gap, and the full grace left phantom planes parked at airports.
    // Back at live, a contact it lacks is from the time the clock left: it
    // goes at once, unless absence keeps it as any poll would (a partial or
    // retaining snapshot, the tracked aircraft), judged by its newest fix.
    // No missed-poll grace, and a landed tracked aircraft is not kept.
    const absenceAtHandover = (icao24) => {
      const likelyLanded = queries._likelyLanded(icao24);
      const judged = records.absence(icao24, {
        complete: snapshot.complete,
        retainIds: snapshot.retainIds,
        likelyLanded,
        tracked: icao24 === flightState._trackedIcao && !likelyLanded,
        nowMs: flightState.now?.(),
      });
      return judged === 'stale' && icao24 !== flightState._trackedIcao
        ? 'remove'
        : judged;
    };
    const absentIds = [];
    for (const icao24 of flightState._icons.ids()) {
      if (!currentIcaos.has(icao24)) absentIds.push(icao24);
    }
    for (const icao24 of absentIds) {
      const absence = replace
        ? 'remove'
        : handover
          ? absenceAtHandover(icao24)
          : records.absence(icao24, {
              complete: snapshot.complete,
              retainIds: snapshot.retainIds,
              likelyLanded: queries._likelyLanded(icao24),
              tracked: icao24 === flightState._trackedIcao,
              nowMs: flightState.now?.(),
            });
      if (absence === 'retain') continue;
      if (absence === 'stale') {
        icons._applyIconPresentation(icao24); // the faded freshness alpha
        if (icao24 === flightState._trackedIcao && flightState._trackedEntity) {
          // Honest readout: the tracked plane has no faded icon (its
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

      icons._forgetContact(icao24); // aged out: its 3D model goes too (no orphan / cap leak)
    }

    // The tracked contact at the new time: its trail starts there. Back at
    // live its trail goes on.
    if (
      replace &&
      flightState._trackedIcao &&
      currentIcaos.has(flightState._trackedIcao)
    )
      tracking._startTrail(flightState._trackedIcao);

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
    // Round 4: sample the RENDERED mesh for those same cells (a few probes
    // per cell, budget-capped, viewer-proximate, google-3d regime only). Own
    // billboards/models are excluded so a vertical probe can't land on an
    // aircraft instead of the pavement.
    rendering._sampleMeshFloor(floorWarmPoints, viewerLatDeg, viewerLonDeg);

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

    return { count: flightState._icons.count, ids: acceptedSnapshotIcaos };
  };
}
