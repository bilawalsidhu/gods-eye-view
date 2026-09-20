import { pickRenderAltitudeM } from '../../data/renderAltitude.js';
import { stickyText, stickyNumber } from '../../data/aircraftMeta.js';
import { classifyAircraft } from '../../data/aircraftClass.js';
import {
  GROUND_FLOOR_WARM_MAX_ALT_M,
  LANDED_MISSING_POLL_LIMIT,
  MISSING_POLL_LIMIT,
} from './recordPolicy.js';

/** Portable military aircraft metadata and bounded missing-poll retention. */
export class MilitaryFlightRecords {
  constructor({ geoidHeight, cachedGroundFloor, floorAltitudeM }) {
    this.services = { geoidHeight, cachedGroundFloor, floorAltitudeM };
    this.data = new Map();
    this.missingPolls = new Map();
    this.geoidNCache = new Map();
    this.geoidReady = false;
  }
  receive(
    aircraft,
    { observedAtMs, floorWarmPoints: _floorWarmPoints, modelOwnsVisual },
  ) {
    const { geoidHeight, cachedGroundFloor, floorAltitudeM } = this.services;
    const { id: icao24, longitude: lon, latitude: lat } = aircraft;
    this.missingPolls.delete(icao24);
    const prevMeta = this.data.get(icao24);
    // adsb.lol/readsb reports GROUND traffic as alt_baro === "ground" (no
    // separate boolean). Grounded planes fall back to their last known
    // altitude (field elevation is unknowable here), else 0 m — never the
    // 3 km airborne default (a parked plane must not float).
    const onGround = aircraft.onGround;
    const altitudeFt =
      aircraft.baroAltitudeM == null ? null : aircraft.baroAltitudeM / 0.3048;
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
    let geoidN = this.geoidNCache.get(icao24);
    if (geoidN === undefined && this.geoidReady) {
      geoidN = geoidHeight(lat, lon);
      this.geoidNCache.set(icao24, geoidN);
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
      if (!modelOwnsVisual) {
        const floor = cachedGroundFloor(lat, lon);
        if (Number.isFinite(floor)) {
          renderAltitudeM = floorAltitudeM(renderAltitudeM, floor);
        }
      }
    }

    // Landing/takeoff transition: the ground flip restyles IN PLACE.
    const groundFlipped =
      !!prevMeta && (prevMeta.onGround === true) !== onGround;
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
      // Raw poll-fix coords (pre-dead-reckon) — the stale-grounded
      // re-floor sweep keys floors off these (mirror of flights.js).
      rawLat: lat,
      rawLon: lon,
    };
    this.data.set(icao24, meta);

    return {
      prevMeta,
      meta,
      groundFlipped,
      fixEpochMs: aircraft.positionTimeMs ?? observedAtMs,
    };
  }
  absence(id, { complete, likelyLanded }) {
    if (
      !complete &&
      Date.now() - (this.data.get(id)?.observedReceiptMs ?? 0) < 300000
    )
      return 'retain';
    const misses = (this.missingPolls.get(id) || 0) + 1;
    const limit = likelyLanded ? LANDED_MISSING_POLL_LIMIT : MISSING_POLL_LIMIT;
    if (misses < limit) {
      this.missingPolls.set(id, misses);
      return 'stale';
    }
    this.missingPolls.delete(id);
    return 'remove';
  }
  forget(id) {
    this.data.delete(id);
    this.missingPolls.delete(id);
    this.geoidNCache.delete(id);
  }
}
