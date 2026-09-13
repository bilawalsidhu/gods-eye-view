import { pickRenderAltitudeM } from '../../data/renderAltitude.js';
import * as Cesium from 'cesium';
import { stickyText, stickyNumber } from '../../data/aircraftMeta.js';
import { classifyAircraft, CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  turnRateFromFixHistory,
  liftRepeatedGroundFix,
  synthesizeForwardKinematicsFix,
} from '../../data/motionModel.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import {
  GROUND_FLOOR_WARM_MAX_ALT_M,
  POSITION_HISTORY_LIMIT,
  BILLBOARD_SCALE,
  GROUND_SCALE,
  TRACKED_ICON_COLOR,
  MIL_ICON_COLOR,
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
  const { geoidHeight } = services.geoid;
  const {
    floorAltitudeM,
    cachedGroundFloor,
    warmGroundFloor,
    GROUND_FLOOR_LIFT_M,
  } = services.groundFloor;
  const { sampleMeshFloorCells } = services.meshFloor;
  const { registerMilitaryIcaos } = services.militaryRegistry;
  const militaryFlightsLayer = layer;

  const methods = {
    /**
     * Fetch the latest military aircraft positions from adsb.lol and reconcile
     * with the billboard collection. Handles error backoff, feed-time-stamped
     * position history updates, and grace-period removal of absent aircraft.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
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
          {},
          { signal: updateSignal },
        );
        updateSignal.throwIfAborted();
        flightState._lastStatus = snapshot.status ?? 200;
        flightState._lastSource = snapshot.source;
        militaryFlightsLayer.source = flightState._lastSource;
        const usableAircraft = snapshot.records;
        flightState._backoff =
          snapshot.stale || snapshot.freshness === 'unknown';
        flightState._retryAt = 0;
        flightState._lastError =
          snapshot.reason ||
          (snapshot.freshness === 'unknown'
            ? 'Source snapshot time unavailable'
            : null);
        const currentIcaos = new Set();
        const receiptNowMs = snapshot.observedAtMs;
        // Field-test fix (RS46): coarse floor cells to warm for the below-ground
        // clamp — collected during the loop (low airborne contacts only),
        // batch-resolved once after it. Never a fetch inside the loop.
        const _floorWarmPoints = [];

        for (const aircraft of usableAircraft) {
          const { id: icao24, longitude: lon, latitude: lat } = aircraft;

          currentIcaos.add(icao24);
          flightState._missingPolls.delete(icao24);

          const prevMeta = flightState._flightData.get(icao24);
          // adsb.lol/readsb reports GROUND traffic as alt_baro === "ground" (no
          // separate boolean). Grounded planes fall back to their last known
          // altitude (field elevation is unknowable here), else 0 m — never the
          // 3 km airborne default (a parked plane must not float).
          const onGround = aircraft.onGround;
          const altitudeFt =
            aircraft.baroAltitudeM == null
              ? null
              : aircraft.baroAltitudeM / 0.3048;
          const altitudeM =
            aircraft.baroAltitudeM ??
            (onGround
              ? Number.isFinite(prevMeta?.altitudeFt)
                ? prevMeta.altitudeFt * 0.3048
                : 0
              : 3048);
          const track = aircraft.courseDeg || 0;
          const speedMps = aircraft.speedMps ?? 0;
          const verticalRateMps = aircraft.verticalRateMps;
          const callsign = aircraft.callsign;
          const type = aircraft.typeCode;
          const registration = aircraft.registration;
          const operator = aircraft.operator;
          const geoAltitudeM = aircraft.ellipsoidAltitudeM;
          const baroAltitudeM = aircraft.baroAltitudeM;

          // geoid undulation N: cached per-aircraft (negligible drift — see
          // task brief) once the geoid grid has loaded; unavailable pre-load
          // just means the baro fallback branch below adds N=0 for a beat.
          let geoidN = flightState._geoidNCache.get(icao24);
          if (geoidN === undefined && flightState._geoidReady) {
            geoidN = geoidHeight(lat, lon);
            flightState._geoidNCache.set(icao24, geoidN);
          }

          // GROUND-SNAP INTERPLAY (brief item 3 — "don't double-correct"): a
          // grounded plane's MODEL already rides groundSnap.js's one-shot tileset
          // sample (_modelDisplayPosition), which is the visual on the ground, and
          // its billboard is depth-test-free (_groundDepthDistance) so its exact
          // height is cosmetic. Deliberately pass surfaceM=null so
          // pickRenderAltitudeM's on-ground surface branch never fires here:
          //  1. It would be the SECOND correction of the same grounded plane
          //     (model tileset-snap is the first) — the exact double-correct the
          //     brief forbids.
          //  2. Military ground rows carry NO baro ("alt_baro":"ground"), so the
          //     grounded billboard sits at 0 m until a surface value warms; letting
          //     surfaceM then jump it 0 -> ~surface (often ~100 m) BETWEEN polls
          //     drags the model's ground-snap input past groundSnap's 50 m
          //     move-invalidation threshold and forces a re-sample every time the
          //     cache warms — breaking the ONE-SHOT-per-(camera,regime) invariant
          //     the track regression locks (qa: sampleHeight count must stay flat).
          // Grounded planes therefore keep the pre-existing `altitudeM` default
          // (last-known baro / 0). The datum fix (alt_geom -> baro+geoidN) is what
          // matters for AIRBORNE military planes — the actual "renders at MSL" bug.
          const pickedAltM = pickRenderAltitudeM({
            geoAltM: geoAltitudeM,
            baroAltM: baroAltitudeM,
            onGround,
            surfaceM: null,
            geoidN,
          });
          // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
          // alt_geom nor alt_baro was ever reported for this aircraft (not even
          // stickily) — fall back to the SAME existing default policy `altitudeM`
          // already uses (which also carries the on-ground 0 m / last-known-baro
          // case), so the two never disagree on the "no data yet" case.
          let renderAltitudeM = pickedAltM != null ? pickedAltM : altitudeM;
          // Field-test fix (RS46 heli-in-hillside, 2026-07-06): a baro-only
          // AIRBORNE contact near steep terrain can compute a render height
          // BELOW the local surface (no alt_geom; baro+N carries QNH error
          // larger than the height above ground). Floor it at the coarse-grid
          // ellipsoidal ground (warm-cache read only — the batch warm below
          // fills cells for later polls). Grounded contacts are deliberately
          // NOT touched: their model rides groundSnap's tileset sample and
          // their billboard is depth-test-free (see the surfaceM:null block
          // above — same one-shot-invariant reasoning).
          if (!onGround && renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M) {
            renderAltitudeM = floorAltitudeM(
              renderAltitudeM,
              cachedGroundFloor(lat, lon),
            );
            _floorWarmPoints.push({ lat, lon });
          } else if (onGround) {
            // Grounded contacts: warm the floor cell, and — round 4 — when NO
            // 3D model owns this contact's visual, lift the billboard itself
            // onto the floor (mesh-first): the R20053 heli sat "straight up in
            // the ground" because grounded rows render at the legacy ~0 m.
            // With a model present the billboard stays put (it hides behind
            // the tileset-snapped model, and moving it would drag groundSnap's
            // input past its move-invalidation threshold — the T7 one-shot
            // invariant the track regression locks).
            _floorWarmPoints.push({ lat, lon });
            const modelOwnsVisual = parts.rendering._modelOwnsVisual(icao24);
            if (!modelOwnsVisual) {
              const floor = cachedGroundFloor(lat, lon);
              if (Number.isFinite(floor)) {
                renderAltitudeM = floorAltitudeM(renderAltitudeM, floor);
              }
            }
          }

          const position = Cesium.Cartesian3.fromDegrees(
            lon,
            lat,
            renderAltitudeM,
          );
          // Landing/takeoff transition: the ground flip restyles IN PLACE.
          const groundFlipped =
            !!prevMeta && (prevMeta.onGround === true) !== onGround;
          // Either flip direction retires the model's ground snap: a departing plane
          // flies free of it, a landing plane earns a fresh sample where it rolls out.
          if (groundFlipped) flightState._groundSnap.forget(icao24);

          // Sticky merge — adsb.lol intermittently drops flight/t/r/ownOp; hold
          // last-known-good (bounded by the layer's eviction, which deletes the entry).
          const stickyType = stickyText(type, prevMeta?.type);
          const meta = {
            sourceReference: aircraft.reference,
            observedReceiptMs: Date.now(),
            callsign: stickyText(callsign, prevMeta?.callsign),
            type: stickyType,
            // Type outranks category automatically inside classifyAircraft.
            klass: classifyAircraft({
              typeCode: stickyType,
              category: aircraft?.category,
            }),
            registration: stickyText(registration, prevMeta?.registration),
            operator: stickyText(operator, prevMeta?.operator),
            altitudeFt: stickyNumber(altitudeFt, prevMeta?.altitudeFt, null),
            // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
            // untouched aviation `altitudeFt` — never rename/replace it (labels,
            // the FL readout, and the landed-fast-cull heuristic all still read
            // altitudeFt/baro).
            geoAltitudeM,
            renderAltitudeM,
            speedMps: stickyNumber(speedMps, prevMeta?.speedMps, null),
            track: stickyNumber(track, prevMeta?.track, null),
            // Analyst seam (additive): sticky like the other kinematics.
            verticalRateMps: stickyNumber(
              verticalRateMps,
              prevMeta?.verticalRateMps,
              null,
            ),
            lastContactEpochMs: stickyNumber(
              aircraft.contactTimeMs,
              prevMeta?.lastContactEpochMs,
              null,
            ),
            turnRateDps: prevMeta?.turnRateDps || 0,
            onGround,
            // Round 7: sticky airborne history (see _likelyLanded).
            wasAirborne: prevMeta?.wasAirborne === true || !onGround,
            // Round 6: lifted occlusion-test point for at/below-ellipsoid
            // renders (mirror of flights.js).
            cullPosition:
              renderAltitudeM < 10
                ? Cesium.Cartesian3.fromDegrees(lon, lat, 12)
                : null,
            // Raw poll-fix coords (pre-dead-reckon) — the stale-grounded
            // re-floor sweep keys floors off these (mirror of flights.js).
            rawLat: lat,
            rawLon: lon,
          };
          flightState._flightData.set(icao24, meta);

          const isTracked = icao24 === flightState._trackedIcao;

          // Append to position history stamped with the FEED's fix epoch.
          // adsb.lol's seen_pos is the AGE in seconds of the last position
          // report, so the fix epoch is receipt time minus that age. Only
          // append when the fix actually advances, so stale repeats don't
          // create zero-dt segments.
          const fixEpochMs = aircraft.positionTimeMs ?? receiptNowMs;
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
            if (isTracked) parts.tracking._appendTrailFix(position.clone());
          } else {
            const modelOwnsGroundVisual =
              parts.rendering._modelOwnsVisual(icao24);
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
                if (isTracked)
                  parts.tracking._appendTrailFix(synthetic.position.clone());
              }
            }
          }

          if (flightState._billboards.has(icao24)) {
            const bb = flightState._billboards.get(icao24);
            // Position AND rotation are owned by the fleet pass (_fleetTick);
            // course changes land on the next rotation pass (forced below).
            // Ground flips (landing/takeoff) restyle this SAME billboard in
            // place — the transition is never a removal.
            if (
              prevMeta?.klass !== meta.klass ||
              groundFlipped ||
              flightState._cockpitContactMode
            ) {
              parts.rendering._applyFleetBillboardPresentation(icao24, bb);
            }
            // Per-class GLBs: a class change can mean a different asset OR scale —
            // resync the live model, any in-flight load, and the tracked
            // standalone (mirror of flights.js).
            if (prevMeta?.klass !== meta.klass)
              parts.rendering._syncModelToClass(icao24);
            // Round 5: depth policy is uniform (always depth-test-free, see
            // _groundDepthDistance) — nothing to flip on landing/takeoff.
          } else {
            const bb = flightState._billboardCollection.add({
              position,
              image: aircraftIcon(
                parts.rendering._iconKind(icao24, meta.klass),
              ),
              width: isTracked ? 24 : 20,
              height: isTracked ? 24 : 20,
              scale:
                BILLBOARD_SCALE *
                (CLASS_SCALE_2D[meta.klass] || 1) *
                (meta.onGround ? GROUND_SCALE : 1),
              // Screen-projected rotation lands on the next fleet tick.
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.ZERO,
              color: isTracked ? TRACKED_ICON_COLOR : MIL_ICON_COLOR,
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
            const info = flightState._flightData.get(icao24);
            parts.tracking._updateTrackedLabelModel(icao24);
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
        for (const [icao24, info] of flightState._flightData) {
          if (!info?.onGround || currentIcaos.has(icao24)) continue;
          if (parts.rendering._modelOwnsVisual(icao24)) continue;
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
          info.cullPosition = null;
          const liftedPos = Cesium.Cartesian3.fromDegrees(
            info.rawLon,
            info.rawLat,
            lifted,
          );
          const hist = flightState._positionHistory.get(icao24);
          const newest = hist?.[hist.length - 1];
          if (newest)
            newest.position = Cesium.Cartesian3.clone(
              liftedPos,
              newest.position,
            );
          const bbStale = flightState._billboards.get(icao24);
          if (bbStale) bbStale.position = liftedPos;
        }
        // Round 4: sample the RENDERED mesh for those cells (one-shot per cell,
        // budget-capped, viewer-proximate, google-3d regime only), excluding
        // this layer's own billboards/models from the probe.
        {
          const viewerCarto =
            flightState._viewer?.camera?.positionCartographic || null;
          sampleMeshFloorCells(flightState._viewer?.scene, _floorWarmPoints, {
            excludeObjects: [
              ...flightState._billboards.values(),
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
              // in _missingPolls, _buildTrackedLabel appends the STALE cue so
              // last-known altitude/speed aren't presented as live.
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
        }

        // Fresh courses arrived — force a rotation pass on the next fleet tick
        flightState._lastCamPoseSig = '';

        // Feed the shared registry so the flights layer can classify/suppress
        registerMilitaryIcaos(currentIcaos);

        flightState._count = flightState._billboards.size;
        flightState._lastUpdate = receiptNowMs;
        flightState._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: currentIcaos,
          source: flightState._lastSource,
        };
        console.log(`[Data:Military] Updated: ${flightState._count} aircraft`);
        parts.tracking._applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Military update aborted', 'AbortError');
        }
        console.warn('[Data:Military] Fetch error:', e);
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
