import { stickyNumber, stickyText } from '../../data/aircraftMeta.js';
import {
  geoidSurfaceLastResortM,
  pickRenderAltitudeM,
} from '../../data/renderAltitude.js';
import { classifyAircraft } from '../../data/aircraftClass.js';
import { aircraftEmergency } from '../../data/aircraftEmergency.js';
import {
  aircraftCallsignRule,
  aircraftModelSpec,
  fleetModelSet,
} from '../../data/fleetModels.js';
import {
  approxDistanceKm,
  GROUND_FLOOR_CLAMP_RADIUS_KM,
  GROUND_FLOOR_WARM_MAX_ALT_M,
  LANDED_MISSING_POLL_LIMIT,
  MISSING_POLL_LIMIT,
  TRACKED_RETENTION_MS,
} from './recordPolicy.js';

/** Source-independent aircraft metadata and bounded missing-poll retention. */
export class FlightRecords {
  constructor({
    geoidHeight,
    cachedGroundFloor,
    floorAltitudeM,
    now = () => Date.now(),
    fleetModels = fleetModelSet,
  }) {
    this.services = {
      geoidHeight,
      cachedGroundFloor,
      floorAltitudeM,
    };
    /** The time records are judged at: the layer's clock. */
    this.now = now;
    /** The loaded fleet model set, or null before it loads. */
    this.fleetModels = fleetModels;
    this.data = new Map();
    // Facts about an airframe, not a moment, kept across a reset.
    this.airframes = new Map();
    this.missingPolls = new Map();
    // Contacts whose last poll re-sent a fix no newer than the one before.
    this.fixRepeated = new Set();
    this.lastSnapshotMs = null;
    this.snapshotAdvanced = true;
    this.geoidNCache = new Map();
    this.geoidReady = false;
  }

  /**
   * Start reading a snapshot taken at `observedAtMs`. A fix re-sent in a
   * newer snapshot marks its contact as not updated; the same snapshot read
   * again does not.
   * @param {number} observedAtMs
   */
  beginSnapshot(observedAtMs) {
    this.snapshotAdvanced =
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(this.lastSnapshotMs) ||
      observedAtMs > this.lastSnapshotMs;
    if (Number.isFinite(observedAtMs))
      this.lastSnapshotMs = Math.max(
        this.lastSnapshotMs ?? -Infinity,
        observedAtMs,
      );
  }

  /** Note a received fix: the newest fix time, and whether it advanced. */
  _noteFix(id, prevMeta, fixEpochMs) {
    const prevFixMs = prevMeta?.newestFixMs;
    // A fix counts as new only when it moves on by a second: feeds that
    // derive fix time from receipt (readsb `now − seen_pos`, 0.1 s) jitter.
    if (!Number.isFinite(prevFixMs) || fixEpochMs >= prevFixMs + 1000) {
      this.fixRepeated.delete(id);
      return fixEpochMs;
    }
    if (this.snapshotAdvanced) this.fixRepeated.add(id);
    return prevFixMs;
  }

  receive(
    observation,
    { viewerLatDeg, viewerLonDeg, trackedId, floorWarmPoints },
  ) {
    const { geoidHeight, cachedGroundFloor, floorAltitudeM } = this.services;
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

    this.missingPolls.delete(icao24);
    // Sticky merge: OpenSky intermittently drops callsign/velocity/track for
    // aircraft it still positions — hold last-known-good instead of
    // regressing to the ICAO hex / a 0° (north) heading. Bounded by the
    // MISSING_POLL_LIMIT eviction below, which deletes the whole entry.
    const prevMeta = this.data.get(icao24);
    // The airframe's facts: this record's, or those kept across a reset.
    const airframe = prevMeta ?? this.airframes.get(icao24);
    this.airframes.delete(icao24);
    // A ground vehicle or ground station (a feed's ZVEH or GRND: a model
    // built standing, catalog category `other`) takes the feed's own type,
    // which no airframe lookup knows; every other aircraft keeps waiting for
    // its looked-up type. With no altitude at all it stands on the ground,
    // where it is, instead of at the airborne default.
    const groundModel = (typeCode) =>
      drawnAsGroundModel(
        this.fleetModels(),
        typeCode,
        category,
        stickyText(callsign, prevMeta?.callsign),
      );
    const feedType = observation.typeCode || null;
    const typeCode =
      airframe?.typeCode ??
      (feedType && groundModel(feedType) ? feedType : null);
    const onGround =
      on_ground === true ||
      (!Number.isFinite(baro_alt) &&
        !Number.isFinite(geo_alt) &&
        groundModel(typeCode));
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
    let geoidN = this.geoidNCache.get(icao24);
    if (geoidN === undefined && this.geoidReady) {
      geoidN = geoidHeight(lat, lon);
      this.geoidNCache.set(icao24, geoidN);
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
        approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <=
          GROUND_FLOOR_CLAMP_RADIUS_KM
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
    // Neither altitude this poll nor a held render height: the height below
    // is the airborne default, invented. The tracked trail keeps no point there.
    const renderAltitudeInvented =
      pickedAltM == null &&
      !onGround &&
      !Number.isFinite(prevMeta?.renderAltitudeM);
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
      (icao24 === trackedId ||
        (viewerLatDeg != null &&
          approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <=
            GROUND_FLOOR_CLAMP_RADIUS_KM))
    ) {
      renderAltitudeM = floorAltitudeM(
        renderAltitudeM,
        cachedGroundFloor(lat, lon),
      );
      floorWarmPoints.push({ lat, lon });
    }

    // Landing/takeoff transition: the on_ground flip restyles IN PLACE.
    const groundFlipped =
      !!prevMeta && (prevMeta.onGround === true) !== onGround;
    // Store flight metadata for click-to-track labels
    const cat = stickyNumber(category, prevMeta?.category, null);
    const nextCallsign = stickyText(callsign, prevMeta?.callsign);
    // A route (and its airline) belongs to the callsign it was looked up for;
    // a new callsign drops it, so an old flight's route never shows under it.
    const routeHeld =
      Boolean(airframe?.routeCallsign) &&
      airframe.routeCallsign === nextCallsign.toUpperCase();
    const fixEpochMs =
      Number.isFinite(observation.positionTimeMs) &&
      observation.positionTimeMs > 0
        ? observation.positionTimeMs
        : this.now();
    const meta = {
      sourceReference: observation.reference,
      observedReceiptMs: this.now(),
      newestFixMs: this._noteFix(icao24, prevMeta, fixEpochMs),
      callsign: nextCallsign,
      altitude: alt,
      // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
      // untouched aviation `altitude` — never rename/replace it (labels,
      // FL readout, route-plausibility, and follow-camera range math all
      // still read `altitude`/baro).
      geoAltitudeM,
      renderAltitudeM,
      renderAltitudeInvented,
      onGround,
      // Round 7: sticky airborne history — the landed fast-cull only
      // applies to contacts that actually flew this session.
      wasAirborne: prevMeta?.wasAirborne === true || !onGround,
      velocity: stickyNumber(velocity, prevMeta?.velocity, 0),
      true_track: stickyNumber(true_track, prevMeta?.true_track, 0),
      category: cat,
      // An adsbdb-enriched type code outranks the coarse OpenSky category.
      klass: classifyAircraft({
        typeCode: airframe?.typeCode ?? null,
        category: cat,
      }),
      turnRateDps: prevMeta?.turnRateDps || 0,
      verticalRate: stickyNumber(vertical_rate, prevMeta?.verticalRate, null),
      // Analyst seam: OpenSky origin_country (state[2]) — additive, sticky
      // like callsign so a transient blank row doesn't blank the field.
      originCountry:
        stickyText(origin_country, prevMeta?.originCountry) || null,
      // Per poll, NOT sticky: an emergency code clears when the crew resets
      // it, so a blank squawk must not hold a stale 7700 on screen.
      squawk: observation.squawk ?? null,
      // One source-switch omission may retain an ADS-B status, while an
      // explicit clear or changed squawk always takes effect immediately.
      emergency:
        observation.emergency === undefined &&
        observation.squawk === prevMeta?.squawk &&
        prevMeta?.emergency?.source === 'ads-b' &&
        (prevMeta?.missingEmergencyPolls ?? 0) < 1
          ? prevMeta.emergency
          : aircraftEmergency(observation),
      missingEmergencyPolls:
        observation.emergency === undefined
          ? (prevMeta?.missingEmergencyPolls ?? 0) + 1
          : 0,
      // OpenSky distinguishes the last position epoch from the last
      // transponder message. The fleet coast horizon uses this actual
      // contact time so a temporarily old position does not hard-freeze
      // while fresh velocity/track messages are still arriving.
      lastContactEpochMs: stickyNumber(
        observation.contactTimeMs,
        prevMeta?.lastContactEpochMs,
        null,
      ),
      // adsbdb enrichment — written by the enrichment callbacks, carried
      // across polls; a ground vehicle's or station's from the feed:
      typeCode,
      typeName: airframe?.typeName ?? null,
      registration: airframe?.registration ?? null,
      airline: routeHeld ? (airframe.airline ?? null) : null,
      route: routeHeld ? (airframe.route ?? null) : null,
      routeCallsign: routeHeld ? airframe.routeCallsign : null,
      // Planespotters photo of the tracked airframe (Core asks it directly).
      photo: airframe?.photo ?? null,
      // The RAW poll fix lat/lon (this tick's OpenSky state-vector
      // coords, pre-dead-reckon) — kept distinct from the continuously
      // dead-reckoned billboard position for any consumer that needs the
      // actual reported fix.
      rawLat: lat,
      rawLon: lon,
    };
    this.data.set(icao24, meta);

    return { icao24, prevMeta, meta, groundFlipped, fixEpochMs };
  }

  absence(
    id,
    { complete, retainIds, likelyLanded, tracked = false, nowMs = this.now() },
  ) {
    const misses = (this.missingPolls.get(id) || 0) + 1;
    // The tracked contact has missed an update: it is stale from the first
    // one, and kept (so the camera keeps its target) until ten minutes after
    // its newest fix, whatever the snapshot says. With no fix time known it
    // takes the ordinary limits below.
    const meta = this.data.get(id);
    const fixMs = meta?.newestFixMs ?? meta?.observedReceiptMs;
    if (tracked && Number.isFinite(fixMs)) {
      if (nowMs - fixMs < TRACKED_RETENTION_MS) {
        this.missingPolls.set(id, misses);
        return 'stale';
      }
      this.missingPolls.delete(id);
      return 'remove';
    }
    // Partial admissions and position-less rows do not prove absence, but
    // retention remains bounded; a likely-landed position-less contact
    // still takes the landed limit.
    if (
      (!complete || (retainIds?.has(id) && !likelyLanded)) &&
      nowMs - (this.data.get(id)?.observedReceiptMs ?? 0) < 300000
    )
      return 'retain';
    const limit = likelyLanded ? LANDED_MISSING_POLL_LIMIT : MISSING_POLL_LIMIT;
    if (misses < limit) {
      this.missingPolls.set(id, misses);
      return 'stale';
    }
    this.missingPolls.delete(id);
    return 'remove';
  }

  /**
   * Forget every observation, as when the world clock jumps to another time:
   * what an airframe is (its type, registration, route and photo) is kept for
   * when it is seen again; where it was and when is not.
   */
  reset() {
    for (const [id, meta] of this.data) {
      this.airframes.set(id, {
        typeCode: meta.typeCode,
        typeName: meta.typeName,
        registration: meta.registration,
        airline: meta.airline,
        route: meta.route,
        routeCallsign: meta.routeCallsign,
        photo: meta.photo,
      });
    }
    this.data.clear();
    this.missingPolls.clear();
    this.fixRepeated.clear();
    this.lastSnapshotMs = null;
    this.snapshotAdvanced = true;
  }

  forget(id) {
    this.data.delete(id);
    this.airframes.delete(id);
    this.missingPolls.delete(id);
    this.fixRepeated.delete(id);
    this.geoidNCache.delete(id);
  }
}

/** Per loaded fleet model set: whether a type, category and callsign rule draw a ground model. */
const groundModelCaches = new WeakMap();

/**
 * Whether an aircraft of this type, emitter category and callsign is drawn
 * with a model built standing on the ground (catalog category `other`: an
 * airport vehicle, a ground station's mast). False before the set loads.
 * Answered once per type, category and callsign rule matched.
 * @param {object|null} set The loaded fleet model set.
 * @param {string|null} typeCode
 * @param {string|number|null} category
 * @param {string|null} callsign
 * @returns {boolean}
 */
function drawnAsGroundModel(set, typeCode, category, callsign) {
  if (!set || !typeCode) return false;
  let cache = groundModelCaches.get(set);
  if (!cache) groundModelCaches.set(set, (cache = new Map()));
  const rule = aircraftCallsignRule(set.types, typeCode, callsign);
  const key = `${typeCode}|${category ?? ''}|${rule}`;
  let ground = cache.get(key);
  if (ground === undefined) {
    ground =
      aircraftModelSpec(set, { typeCode, category, callsign }).category ===
      'other';
    cache.set(key, ground);
  }
  return ground;
}
