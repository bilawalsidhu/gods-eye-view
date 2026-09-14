import * as Cesium from 'cesium';
import { stickyNumber, stickyText } from '../../data/aircraftMeta.js';
import {
  geoidSurfaceLastResortM,
  pickRenderAltitudeM,
} from '../../data/renderAltitude.js';
import { classifyAircraft } from '../../data/aircraftClass.js';
import {
  turnRateFromFixHistory,
  liftRepeatedGroundFix,
  synthesizeForwardKinematicsFix,
} from '../../data/motionModel.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import {
  GROUND_FLOOR_CLAMP_RADIUS_KM,
  GROUND_FLOOR_WARM_MAX_ALT_M,
  POSITION_HISTORY_LIMIT,
  LANDED_MISSING_POLL_LIMIT,
  MISSING_POLL_LIMIT,
  ERROR_BACKOFF_INTERVAL,
} from './policy.js';

export function createIngestion({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { refreshMilitaryRegistryIfStale, isMilitaryIcao } =
    services.militaryRegistry;
  const { geoidHeight } = services.geoid;
  const { cachedGroundFloor, floorAltitudeM, warmGroundFloor } =
    services.groundFloor;
  const { sampleMeshFloorCells } = services.meshFloor;
  const flightsLayer = layer;

  const methods = {
    /**
     * Fetch the latest aircraft state vectors from the OpenSky proxy and
     * reconcile them with the billboard collection.
     *
     * Handles HTTP 429 (rate-limit), 401/403 (auth), and transient errors
     * with exponential-ish backoff.  On success, adds/updates/removes
     * billboards and position history, triggers lerp blending for the
     * tracked aircraft, and updates its label text.
     *
     * @param {Cesium.Viewer} viewer
     * @returns {Promise<void>}
     */
    async update(viewer, { signal = null } = {}) {
      const nowMs = Date.now();
      const trackingRefreshEpoch = ++flightState._trackingRefreshEpoch;
      flightState._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        ids: new Set(),
        source: flightState._lastSource,
        coverage: flightState._lastCoverage,
      };
      if (flightState._retryAt && nowMs < flightState._retryAt) {
        flightState._backoff = true;
        return;
      }

      const resourceController = new AbortController();
      flightState._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        const snapshot = await flightState._source.getSnapshot(
          parts.controller._flightQuery(viewer || flightState._viewer),
          { signal: updateSignal },
        );
        updateSignal.throwIfAborted();
        flightState._lastStatus = snapshot.status ?? 200;
        const usableStates = snapshot.records;
        const sourceEpochMs = snapshot.observedAtMs;
        const sourceAgeMs = snapshot.ageMs;
        const sourceStale = snapshot.stale || snapshot.freshness === 'unknown';
        flightState._backoff = sourceStale;
        flightState._retryAt = 0;
        flightState._lastError = sourceStale
          ? sourceAgeMs == null
            ? 'Source snapshot time unavailable'
            : `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
          : null;
        flightState._lastSource = snapshot.source;
        flightState._lastCoverage = snapshot.coverage;
        flightsLayer.source = flightState._lastSource;
        const currentIcaos = new Set();
        const acceptedSnapshotIcaos = new Set();
        const now = Cesium.JulianDate.now();
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
        for (const observation of usableStates) {
          const {
            id: icao24,
            callsign,
            originCountry: origin_country,
            longitude: lon,
            latitude: lat,
            baroAltitudeM: baro_alt,
            onGround: on_ground,
            speedMps: velocity,
            courseDeg: true_track,
            ellipsoidAltitudeM: geo_alt,
            category,
            verticalRateMps: vertical_rate,
          } = observation;
          acceptedSnapshotIcaos.add(icao24);
          const onGround = on_ground === true;

          // Known-military aircraft: the dedicated military layer wins
          // (icon + track + click) while it is enabled — suppress the
          // OpenSky duplicate entirely (except a currently tracked one,
          // which hands off on untrack).
          const isMil = isMilitaryIcao(icao24);
          if (isMil && parts.tracking._militaryLayerSuppresses(icao24)) {
            const dupe = flightState._billboards.get(icao24);
            if (dupe) {
              flightState._billboardCollection.remove(dupe);
              flightState._billboards.delete(icao24);
              parts.rendering._releaseModel(icao24); // military-suppression: drop any 3D model too
              flightState._flightData.delete(icao24);
              flightState._positionHistory.delete(icao24);
              flightState._displayCourse.delete(icao24);
              flightState._groundSnap.forget(icao24);
              flightState._missingPolls.delete(icao24);
              flightState._geoidNCache.delete(icao24);
            }
            continue;
          }

          currentIcaos.add(icao24);
          flightState._missingPolls.delete(icao24);
          // Sticky merge: OpenSky intermittently drops callsign/velocity/track for
          // aircraft it still positions — hold last-known-good instead of
          // regressing to the ICAO hex / a 0° (north) heading. Bounded by the
          // MISSING_POLL_LIMIT eviction below, which deletes the whole entry.
          const prevMeta = flightState._flightData.get(icao24);
          // Grounded planes with no baro reading sit at 0 m, not the 10 km
          // airborne default (a parked plane must never float).
          // NOTE (height-datum fix): `alt` stays the AVIATION field — the sticky
          // barometric/MSL altitude read by labels (FL/altitude readout),
          // route-plausibility, and follow-camera range heuristics. It is
          // NEVER overwritten or renamed. Where the aircraft actually RENDERS
          // on the ellipsoidal globe is a SEPARATE value (renderAltitudeM,
          // below) — geo_altitude when OpenSky reports it (already WGS84
          // ellipsoidal), else baro+geoid as a visual fallback, else ground
          // surface when parked. `Cartesian3.fromDegrees` gets renderAltitudeM,
          // never `alt` directly.
          const alt = stickyNumber(
            baro_alt,
            prevMeta?.altitude,
            onGround ? 0 : 10000,
          );

          // geoid undulation N: cached per-aircraft (negligible drift — see
          // task brief) once the geoid grid has loaded; unavailable pre-load
          // just means the baro fallback branch below adds N=0 for a beat.
          let geoidN = flightState._geoidNCache.get(icao24);
          if (geoidN === undefined && flightState._geoidReady) {
            geoidN = geoidHeight(lat, lon);
            flightState._geoidNCache.set(icao24, geoidN);
          }

          // on_ground surface prior: ONLY synchronous warm-cache reads here —
          // never a per-aircraft network fetch inside the poll loop (see the
          // batch resolve call below, which fills this cache for NEXT poll). A
          // Round 5 SIMPLIFICATION (owner directive: one floor, evenly applied):
          // the grounded surface is the round-4 choke point and nothing else —
          // rendered-mesh cell first, real (never fallback-poisoned) DEM cell
          // second. The old exact-5-decimal warm chain is GONE: it minted a new
          // key per parked-jitter poll for every grounded contact ON EARTH,
          // hammering Re:Earth into the very failures that poisoned the cache.
          let surfaceM = null;
          if (onGround) {
            surfaceM = cachedGroundFloor(lat, lon); // mesh ?? real DEM (coarse cell)
            // Taxiing crosses into a fresh cold cell every poll — always one
            // step ahead of the warm batch — so fall back to LAST poll's cell
            // (warmed by last poll's batch; aprons are flat across adjacent
            // 111 m cells). Round-5 verify caught taxiing contacts stuck at
            // the geoid without this (round 2's lesson, at cell granularity).
            if (
              surfaceM == null &&
              Number.isFinite(prevMeta?.rawLat) &&
              Number.isFinite(prevMeta?.rawLon)
            ) {
              surfaceM = cachedGroundFloor(prevMeta.rawLat, prevMeta.rawLon);
            }
            // Grounded contacts near the viewer feed the floor warm/sampler
            // (the only ones whose exact height is visible; far contacts are
            // subpixel and always-on-top anyway).
            if (
              viewerLatDeg != null &&
              parts.queries._approxDistanceKm(
                viewerLatDeg,
                viewerLonDeg,
                lat,
                lon,
              ) <= GROUND_FLOOR_CLAMP_RADIUS_KM
            ) {
              floorWarmPoints.push({ lat, lon });
            }
            // Last synchronous resort for a BRAND-NEW grounded contact with NO
            // altitude data at all (nothing warm yet, not even the coarse
            // cell): the geoid surface. At the sea-level airports where most
            // grounded traffic sits, geoidN IS the local ellipsoidal ground to
            // within metres — instantly right — and at elevated fields it is
            // far less wrong than the raw 0 m ellipsoid default for the one
            // poll until the coarse cell warms. STRICTLY gated on "no geo, no
            // baro": a reported baro already reflects the field elevation, and
            // pickRenderAltitudeM's surfaceM branch would let this crude guess
            // outrank it (caught by the ground-3d track regression).
            //
            // 2026-08-21: the rule moved to geoidSurfaceLastResortM, which adds
            // one more gate — a contact that already HAS a render height keeps
            // it. Leaving surfaceM null routes it through the sentinel path
            // below, which holds that height.
            if (surfaceM == null) {
              surfaceM = geoidSurfaceLastResortM({
                geoAltM: geo_alt,
                baroAltM: baro_alt,
                priorRenderM: prevMeta?.renderAltitudeM,
                geoidN,
              });
            }
          }

          const geoAltitudeM = Number.isFinite(geo_alt) ? geo_alt : null;
          const pickedAltM = pickRenderAltitudeM({
            geoAltM: geoAltitudeM,
            baroAltM: Number.isFinite(baro_alt) ? baro_alt : null,
            onGround,
            surfaceM,
            geoidN,
          });
          // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
          // geo_altitude nor baro_altitude was reported THIS poll. Two fallbacks,
          // in priority order:
          //   (1) hold the previous geoid-corrected render height if we have one —
          //       a one-poll baro dropout must NOT snap the plane down by the geoid
          //       undulation N (~46 m in London) and back up next poll. `alt` stays
          //       sticky for labels, so holding the last render height keeps the two
          //       layers consistent through the gap.
          //   (2) otherwise the SAME default policy `alt` already uses, so the two
          //       never disagree on the genuine "no data yet" case (a never-reported
          //       aircraft has no prior render height, so it lands here unchanged).
          let renderAltitudeM;
          if (pickedAltM != null) {
            renderAltitudeM = pickedAltM;
          } else if (Number.isFinite(prevMeta?.renderAltitudeM)) {
            renderAltitudeM = prevMeta.renderAltitudeM;
          } else {
            renderAltitudeM = alt;
          }
          // Field-test fix (WAKE01/RS46 class, 2026-07-06; widened round 3):
          // floor a low airborne contact's render height at the local coarse
          // ground so it can never dive below the mesh. Round 3 (Austin
          // fleet-underground): baro can read BELOW an elevated field — SWA696
          // showed 450 ft at Austin's 542 ft field elevation — and rollout/taxi
          // traffic that OpenSky hasn't flagged on_ground yet renders from that
          // baro, so the whole fleet sat buried at AUS in 2D. Clamping every
          // global contact would need unbounded terrain resolution; instead the
          // clamp covers the TRACKED contact (always) plus every low contact
          // within GROUND_FLOOR_CLAMP_RADIUS_KM of the viewer — the only ones
          // whose burial is visible. Cells warm in one batch after the loop.
          // Airborne only (grounded planes keep the surface-cache path above).
          if (
            !onGround &&
            renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M &&
            (icao24 === flightState._trackedIcao ||
              (viewerLatDeg != null &&
                parts.queries._approxDistanceKm(
                  viewerLatDeg,
                  viewerLonDeg,
                  lat,
                  lon,
                ) <= GROUND_FLOOR_CLAMP_RADIUS_KM))
          ) {
            renderAltitudeM = floorAltitudeM(
              renderAltitudeM,
              cachedGroundFloor(lat, lon),
            );
            floorWarmPoints.push({ lat, lon });
          }

          const position = Cesium.Cartesian3.fromDegrees(
            lon,
            lat,
            renderAltitudeM,
          );
          // Landing/takeoff transition: the on_ground flip restyles IN PLACE.
          const groundFlipped =
            !!prevMeta && (prevMeta.onGround === true) !== onGround;
          // Either flip direction retires the model's ground snap: a departing plane
          // flies free of it, a landing plane earns a fresh sample where it rolls out.
          if (groundFlipped) flightState._groundSnap.forget(icao24);

          // Store flight metadata for click-to-track labels
          const cat = stickyNumber(category, prevMeta?.category, null);
          const meta = {
            sourceReference: observation.reference,
            observedReceiptMs: Date.now(),
            callsign: stickyText(callsign, prevMeta?.callsign),
            altitude: alt,
            // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
            // untouched aviation `altitude` — never rename/replace it (labels,
            // FL readout, route-plausibility, and follow-camera range math all
            // still read `altitude`/baro).
            geoAltitudeM,
            renderAltitudeM,
            onGround,
            // Round 7: sticky airborne history — the landed fast-cull only
            // applies to contacts that actually flew this session.
            wasAirborne: prevMeta?.wasAirborne === true || !onGround,
            // Round 6: lifted occlusion-test point for contacts rendering
            // at/below the ellipsoid (fleet pass reads it — see the occluder
            // note there). Null for the overwhelmingly common airborne case.
            cullPosition:
              renderAltitudeM < 10
                ? Cesium.Cartesian3.fromDegrees(lon, lat, 12)
                : null,
            velocity: stickyNumber(velocity, prevMeta?.velocity, 0),
            true_track: stickyNumber(true_track, prevMeta?.true_track, 0),
            category: cat,
            // An adsbdb-enriched type code outranks the coarse OpenSky category.
            klass: classifyAircraft({
              typeCode: prevMeta?.typeCode ?? null,
              category: cat,
            }),
            turnRateDps: prevMeta?.turnRateDps || 0,
            verticalRate: stickyNumber(
              vertical_rate,
              prevMeta?.verticalRate,
              null,
            ),
            // Analyst seam: OpenSky origin_country (state[2]) — additive, sticky
            // like callsign so a transient blank row doesn't blank the field.
            originCountry:
              stickyText(origin_country, prevMeta?.originCountry) || null,
            // OpenSky distinguishes the last position epoch from the last
            // transponder message. The fleet coast horizon uses this actual
            // contact time so a temporarily old position does not hard-freeze
            // while fresh velocity/track messages are still arriving.
            lastContactEpochMs: stickyNumber(
              observation.contactTimeMs,
              prevMeta?.lastContactEpochMs,
              null,
            ),
            // adsbdb enrichment — written by the enrichment callbacks, carried across polls:
            typeCode: prevMeta?.typeCode ?? null,
            typeName: prevMeta?.typeName ?? null,
            registration: prevMeta?.registration ?? null,
            airline: prevMeta?.airline ?? null,
            route: prevMeta?.route ?? null,
            // The RAW poll fix lat/lon (this tick's OpenSky state-vector
            // coords, pre-dead-reckon) — kept distinct from the continuously
            // dead-reckoned billboard position for any consumer that needs the
            // actual reported fix.
            rawLat: lat,
            rawLon: lon,
          };
          flightState._flightData.set(icao24, meta);

          const isTracked = icao24 === flightState._trackedIcao;

          // Append to position history stamped with the FEED's fix epoch
          // (time_position), not client receipt time — OpenSky positions arrive
          // 5-15s stale and receipt-time stamping is what caused the
          // back/forward oscillation. Only append when the fix actually
          // advances, so stale repeats don't create zero-dt segments.
          const fixEpochMs =
            Number.isFinite(observation.positionTimeMs) &&
            observation.positionTimeMs > 0
              ? observation.positionTimeMs
              : Date.now();
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
            if (isTracked) parts.tracking._appendTrailFix(position.clone());
          } else {
            const modelOwnsGroundVisual =
              parts.rendering._modelOwnsVisual(icao24);
            if (!modelOwnsGroundVisual) {
              liftRepeatedGroundFix(newest, position, meta.onGround);
            }
            // Apply fresh kinematics only from a forward synthetic fix. Mutating
            // the historical fix reprojects the entire stale interval and snaps
            // the rendered aircraft when course or speed changes late.
            const kinematicsChanged =
              newest.velocity !== meta.velocity ||
              newest.track !== meta.true_track;
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
                if (isTracked)
                  parts.tracking._appendTrailFix(synthetic.position.clone());
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
              bb.color = parts.rendering
                ._fleetBillboardColor(icao24)
                .withAlpha(bb.color?.alpha ?? 1);
            }
            if (
              prevMeta?.klass !== meta.klass ||
              groundFlipped ||
              flightState._cockpitContactMode
            ) {
              parts.rendering._applyFleetBillboardPresentation(icao24, bb);
            }
            // Poll-path class change (category updates): same model resync rule
            // as the enrichment path — the class's GLB/scale may have changed.
            if (prevMeta?.klass !== meta.klass)
              parts.rendering._syncModelToClass(icao24);
          } else {
            const bb = flightState._billboardCollection.add({
              position,
              image: aircraftIcon(
                parts.rendering._iconKind(icao24, meta.klass),
              ),
              width: isTracked ? 24 : 20,
              height: isTracked ? 24 : 20,
              scale: parts.rendering._fleetBillboardScale(icao24, meta.klass),
              // Screen-projected rotation lands on the next fleet tick.
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.ZERO,
              color: isTracked
                ? Cesium.Color.CYAN
                : parts.rendering._fleetBillboardColor(icao24),
              sizeInMeters: false,
              scaleByDistance:
                parts.rendering._normalBillboardScaleByDistance(),
              // Grounded/near-surface planes sit at/below the photoreal tile
              // surface — render them depth-test-free so they never vanish up
              // close (_groundDepthDistance).
              disableDepthTestDistance: parts.rendering._groundDepthDistance(),
              id: icao24,
              show: !isTracked, // hidden if currently tracked (entity replaces it)
            });
            flightState._billboards.set(icao24, bb);
            parts.rendering._applyFleetBillboardPresentation(icao24, bb);
          }

          // Takeoff while TRACKED: ground traffic drew no trail, so start one
          // from the fresh airborne history (touchdown needs no action — the
          // append gate above simply freezes the existing trail).
          if (isTracked && groundFlipped && !meta.onGround)
            parts.tracking._startTrail(icao24);

          // If this is the tracked aircraft, update label text
          // (position updates automatically via dead-reckoning CallbackProperty)
          if (isTracked && flightState._trackedEntity) {
            parts.tracking._updateTrackedLabelModel(icao24);
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
          // Partial admissions do not prove absence, but stale retention is bounded.
          if (
            !snapshot.complete &&
            Date.now() -
              (flightState._flightData.get(icao24)?.observedReceiptMs ?? 0) <
              300000
          )
            continue;
          const misses = (flightState._missingPolls.get(icao24) || 0) + 1;
          const limit = parts.queries._likelyLanded(icao24)
            ? LANDED_MISSING_POLL_LIMIT
            : MISSING_POLL_LIMIT;
          if (misses < limit) {
            flightState._missingPolls.set(icao24, misses);
            if (
              icao24 === flightState._trackedIcao &&
              flightState._trackedEntity
            ) {
              // Honest readout: the tracked plane has no faded billboard (its
              // entity owns the visual), so refresh the label — with icao24 now
              // in _missingPolls, _trackedLabelText appends the STALE cue so
              // last-known velocity/altitude aren't presented as live.
              parts.tracking._updateTrackedLabelModel(icao24);
            }
            continue;
          }
          flightState._missingPolls.delete(icao24);

          // If the tracked flight is truly gone, clear tracking BEFORE deleting
          // its state (M3 ordering, keep it): teardown reads the maps this loop
          // is about to delete (billboard restore, DR cache reset), and we must
          // never leave the camera mid-follow with stale tracking state. The
          // camera is then RELEASED IN PLACE — it stays where the follow left
          // it, fully free (owner decision 2026-07-02: no overview flyTo).
          if (icao24 === flightState._trackedIcao) {
            parts.tracking._clearTracking(false, { evicted: true });
          }

          flightState._billboardCollection.remove(bb);
          flightState._billboards.delete(icao24);
          parts.rendering._releaseModel(icao24); // aged-out aircraft: drop its 3D model (no orphan / cap leak)
          flightState._flightData.delete(icao24);
          flightState._positionHistory.delete(icao24);
          flightState._displayCourse.delete(icao24);
          flightState._groundSnap.forget(icao24);
          flightState._geoidNCache.delete(icao24);
          flightState._displayFloorState.delete(icao24);
        }

        // Fresh courses arrived — force a rotation pass on the next fleet tick
        flightState._lastCamPoseSig = '';

        // Ambient type enrichment: give ON-SCREEN planes real types (bounded
        // sweep — see _sweepAmbientEnrichment; internally fail-silent).
        parts.enrichment._sweepAmbientEnrichment();

        // 2026-08-19: the loop above only ever collects FIX cells, but a grounded
        // contact renders across every cell its dead-reckoned position drifts
        // through. Add those too, so the display clamp has data where the contact
        // actually is instead of silently passing.
        parts.motion._collectDisplayCorridorCells(
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
        parts.motion._refloorStaleGroundedContacts(currentIcaos);

        flightState._count = flightState._billboards.size;
        // Freshness belongs to the source snapshot, not the moment this browser
        // received a cached 200 response.
        flightState._lastUpdate = sourceEpochMs;
        flightState._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: acceptedSnapshotIcaos,
          source: flightState._lastSource,
          coverage: flightState._lastCoverage,
        };
        console.log(`[Data:Flights] Updated: ${flightState._count} aircraft`);
        parts.tracking._applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Flights update aborted', 'AbortError');
        }
        console.warn('[Data:Flights] Fetch error:', e);
        flightState._backoff = true;
        flightState._retryAt =
          Date.now() + (e?.retryAfterMs ?? ERROR_BACKOFF_INTERVAL);
        flightState._lastStatus = e?.status ?? null;
        if (e?.source) {
          flightState._lastSource = e.source;
          this.source = flightState._lastSource;
        }
        flightState._lastError =
          e?.name === 'LiveSourceError' ? e.message : 'Live data unavailable';
      } finally {
        flightState._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}
