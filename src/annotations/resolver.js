import { isUnavailableCapability } from '../sources/capability.js';
import { requireFeatureSource } from '../sources/featureSource.js';
import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
import {
  ringAreaM2,
  stitchLine,
  bufferCorridor,
  simplifyRing,
  closeRing,
  ringCentroid,
  approximateAreaM2,
  approximateDistanceM,
  pointInPolygon,
} from '../sources/featureGeometry.js';
import { defaultGeospatial } from '../search/defaults.js';
import * as Cesium from 'cesium';
import { lookupNeighborhoodRing } from '../data/neighborhoodPolygons.js';
import {
  lookupNaturalRegionOutline,
  findNaturalRegion,
} from '../data/naturalEarthRegions.js';
import {
  registerDynamicCredit,
  NATURAL_EARTH_CREDIT,
} from '../data/dataCredits.js';
import { unavailablePlaceSearch } from '../search/placeSearch.js';
import { isPickedWorldPosition } from '../data/scenePick.js';

/** Ms the analyst region lookup waits on geocode + admin boundary. */
export const REGION_FALLBACK_BUDGET_MS = 3_000;

/** Own annotation lookup caches and ranking of supplied feature candidates. */
export function createAnnotationResolver({
  boundarySource,
  signal: lifetime,
  featureSource = createOverpassFeatureSource({
    boundarySource,
    signal: lifetime,
  }),
} = {}) {
  requireFeatureSource(featureSource);
  lifetime?.throwIfAborted();

  /**
   * Annotation target resolver.
   *
   * The voice agent points things out by NAME (preferred) or explicit lat/lng.
   * Research takeaway: vision models are unreliable at counting pixels on
   * photoreal/oblique imagery, so we never ask the model to box pixels — we
   * resolve a place name to a real-world coordinate (and, when useful, a real
   * OSM footprint ring) and anchor the annotation in world space. That makes the
   * annotation persist correctly as the camera moves and occlude naturally.
   *
   * This mirrors the geocode + Overpass-footprint patterns already used by
   * `src/locations.js` (searchAndFlyTo / resolveBuildingBounds) but returns the
   * raw geometry ring instead of a bounding box, which is what an outline needs.
   */

  const footprintCache = new Map();
  const monumentCache = new Map(); // OSM monuments/memorials near a view center, keyed by rounded coord
  const enclosingAreaCache = new Map(); // smallest enclosing named non-building polygon, keyed by ~1km coord bucket

  // Cache entries are { value, at }. Positive results live indefinitely; negative
  // (not-found) results expire after this TTL so one bad moment doesn't poison a key
  // for the whole session.
  const NEG_CACHE_TTL_MS = 60_000;

  /** Read a cache entry → value | null (cached not-found within TTL) | undefined (miss/expired). */
  function cacheRead(cache, key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.value !== null) return entry.value; // positive — always valid
    if (Date.now() - entry.at <= NEG_CACHE_TTL_MS) return null; // negative within TTL
    cache.delete(key); // expired negative → allow a re-fetch
    return undefined;
  }

  /** Write a positive (or definitive-null) cache entry with a timestamp. */
  function cacheWrite(cache, key, value) {
    if (lifetime?.aborted) return;
    cache.set(key, { value, at: Date.now() });
  }

  /**
   * Cache a null (not-found) result — but ONLY when it is DEFINITIVE (the upstream
   * answered "no such place"), never on an abort or a transient error (network /
   * 429 / 5xx / timeout). Caching those would poison the key; instead we leave it a
   * miss so the next attempt retries. Definitive negatives still carry a TTL.
   */
  function negCache(cache, key, signal, definitive = true) {
    if (signal?.aborted) return; // superseded — never cache
    if (!definitive) return; // transient upstream failure — allow a retry
    cacheWrite(cache, key, null);
  }

  /** Wire an external AbortSignal to a local controller; returns a detach fn. */
  function linkAbort(controller, externalSignal) {
    if (!externalSignal) return () => {};
    if (externalSignal.aborted) {
      controller.abort();
      return () => {};
    }
    const onAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onAbort, { once: true });
    return () => externalSignal.removeEventListener('abort', onAbort);
  }

  /**
   * Resolve a single annotation target to a normalized world anchor.
   *
   * @param {object} opts
   * @param {Cesium.Viewer} opts.viewer
   * @param {string} [opts.target]      Place name to geocode.
   * @param {number} [opts.latitude]    Explicit latitude (wins over target).
   * @param {number} [opts.longitude]   Explicit longitude.
   * @param {boolean} [opts.footprint]  Try to trace the real OSM outline ring.
   * @param {string} [opts.entityKind]  Voice model's entity FACT ('building'|'compound'|
   *                                    'district'|'street'|'point_feature') — refines scope
   *                                    routing and the point-first contract; never a style choice.
   * @param {boolean} [opts.deferFootprint]  Progressive mode: return the anchor immediately
   *                                    (ring:null) plus a `resolveOutline()` continuation the
   *                                    caller runs AFTER drawing, upgrading the mark in place.
   * @returns {Promise<null | {
   *   lon: number, lat: number, height: number,
   *   ring: Array<[number, number]> | null,
   *   label: string | null, source: string,
   *   viewport: object | null,
   *   resolveOutline?: () => Promise<undefined | null | { rateLimited: true, retryAfterMs: number | null }
   *     | { ring, footprintKind, buildingHeight, synthesized, lat, lon, height }>,
   * }>}
   */
  async function resolveAnnotationTarget({
    placeSearch = unavailablePlaceSearch,
    viewer,
    target,
    latitude,
    longitude,
    footprint = false,
    intent = 'the_thing',
    entityKind = null,
    labelHint = null,
    deferFootprint = false,
    allowDistant = false,
    screenX,
    screenY,
    signal,
  }) {
    signal = lifetime
      ? signal
        ? AbortSignal.any([lifetime, signal])
        : lifetime
      : signal;
    signal?.throwIfAborted();
    let lon = Number(longitude);
    let lat = Number(latitude);
    let label = null;
    let source = 'coordinate';
    let geocodeTypes = [];
    let geocodePrimary = null;
    // The Places `viewport` (lat/lng box framing the resolved place), captured when a
    // Places Text Search anchors the target. Used downstream to SIZE a fallback grounds
    // disc to the real feature instead of a blind GROUNDS_RADIUS_M constant.
    let placeViewport = null;
    // Canonical Places display name + `types` of the anchored feature — the Places
    // analogue of geocodePrimary/geocodeTypes: the name feeds OSM matching stripped of
    // locality suffixes; the types classify the entity (point-like vs area-like).
    let placesPrimary = null;
    let placeTypes = [];
    // Instrumentation (logged once per target at the end): which sources were tried and what they returned.
    const trace = {
      query: String(target || '').trim(),
      places: 'skipped',
      geocode: 'none',
      osmSnap: 'skipped',
    };
    // Guard bypass is an ASK-SIDE fact. A returned admin type can be a wrong match
    // ("the Texas Capitol" → the state), so geocode types must never grant it.
    const bypassNearViewGuards = Boolean(adminScopeFromAsk(target, entityKind));

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const query = String(target || '').trim();
      if (query) {
        const center =
          pickWorldFromScreen(viewer, 0.5, 0.5) || viewportProximity(viewer);
        // Monument / grounds names scatter under Geocoding — try a view-biased Places Text Search FIRST.
        // A hit near the view centre is trusted (skips the proximity gate, like the osm-local snap); on a
        // miss we fall through to geocode + fetchLocalMonument below. The model's entityKind counts too:
        // a point_feature by fact ("Heroes of the Alamo" — no monument word) deserves the same path.
        if (
          center &&
          (isMonumentLikeQuery(query) ||
            isGroundsLikeQuery(query) ||
            entityKind === 'point_feature')
        ) {
          const placeHit = await placesTextSearch(
            query,
            center.lat,
            center.lon,
            6000,
            signal,
            placeSearch,
          );
          if (placeHit) {
            trace.places = `${placeHit.lat.toFixed(5)},${placeHit.lon.toFixed(5)}`;
            if (placeHit.distanceM <= PLACES_MAX_DISTANCE_M) {
              lat = placeHit.lat;
              lon = placeHit.lon;
              label = placeHit.label;
              placeViewport = placeHit.viewport || null;
              placesPrimary = placeHit.label;
              placeTypes = placeHit.types || [];
              source = 'places';
            }
          } else {
            trace.places = 'miss';
          }
        }
        if (source !== 'places') {
          const geocoded = await geocodePlace(
            query,
            viewportBias(viewer),
            signal,
            placeSearch,
          );
          if (geocoded) {
            lat = geocoded.lat;
            lon = geocoded.lon;
            label = geocoded.label;
            geocodeTypes = geocoded.types || [];
            geocodePrimary = geocoded.primaryName || null;
            placeViewport = geocoded.viewport || null;
            source = 'geocode';
            trace.geocode = `${geocoded.lat.toFixed(5)},${geocoded.lon.toFixed(5)}`;
          }
          // RECOVERY: a plain landmark ("the Capitol") can Geocode to a FAR city (Washington DC) that the
          // proximity gate would then reject as an honest miss — but the user means the one they're
          // LOOKING AT. If the geocode missed or landed far from the view centre, try a view-biased
          // Places Text Search; a hit within the trust bound overrides + skips the gate. Local geocodes
          // (neighborhoods, nearby buildings) are NOT far, so they keep the geocode + scope/polygon path.
          if (
            center &&
            trace.places === 'skipped' &&
            !bypassNearViewGuards &&
            !allowDistant
          ) {
            let geocodeFar = source !== 'geocode';
            if (
              source === 'geocode' &&
              approximateDistanceM(center.lat, center.lon, lat, lon) / 1000 >
                MIN_DRIFT_FLOOR_KM
            ) {
              geocodeFar = true;
            }
            if (geocodeFar) {
              const placeHit = await placesTextSearch(
                query,
                center.lat,
                center.lon,
                6000,
                signal,
                placeSearch,
              );
              if (placeHit && placeHit.distanceM <= PLACES_MAX_DISTANCE_M) {
                lat = placeHit.lat;
                lon = placeHit.lon;
                label = placeHit.label;
                placeViewport = placeHit.viewport || null;
                placesPrimary = placeHit.label;
                placeTypes = placeHit.types || [];
                geocodeTypes = [];
                geocodePrimary = null;
                source = 'places';
                trace.places = `${placeHit.lat.toFixed(5)},${placeHit.lon.toFixed(5)} (recovery)`;
              } else {
                trace.places = placeHit ? 'far-ignored' : 'miss';
              }
            }
          }
        }
      }
    }

    // Pixel fallback: the agent pointed at the viewport screenshot but the place
    // could not be named/geocoded. Convert the normalized pixel back into a world
    // coordinate via the depth-aware pick cascade, so the mark is STILL
    // world-anchored (it persists and occludes like any other) rather than a
    // transient frame-bound overlay.
    if (
      (!Number.isFinite(lat) || !Number.isFinite(lon)) &&
      Number.isFinite(Number(screenX)) &&
      Number.isFinite(Number(screenY))
    ) {
      const picked = pickWorldFromScreen(
        viewer,
        Number(screenX),
        Number(screenY),
      );
      if (picked) {
        lat = picked.lat;
        lon = picked.lon;
        source = 'pixel';
      }
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    // Monument/memorial/statue names geocode unreliably — Google scatters them across the city (e.g.
    // several Texas Capitol monuments landed blocks-to-miles apart, looking "all over the map"). When
    // the target reads like a monument AND the anchor came from a NAME, snap to the actual OSM feature
    // near what the user is LOOKING AT (screen-centre), not the scattered geocode point. A hit becomes
    // an 'osm-local' anchor (near the view by construction, so it skips the proximity gate below).
    if (
      source === 'geocode' &&
      (isMonumentLikeQuery(target) || entityKind === 'point_feature')
    ) {
      const center =
        pickWorldFromScreen(viewer, 0.5, 0.5) || viewportProximity(viewer);
      if (center) {
        const mon = await fetchLocalMonument(
          center.lat,
          center.lon,
          target,
          signal,
        );
        if (mon) {
          lat = mon.lat;
          lon = mon.lon;
          label = label || mon.label;
          source = 'osm-local';
          trace.osmSnap = 'hit';
        } else {
          trace.osmSnap = 'miss';
        }
      }
    }

    // Whether this anchor came from geocoding a NAME (vs. explicit coords / pixel / osm-local). Only
    // name-geocoded anchors are subject to the proximity gate below — coords/pixels/local are trusted.
    const fromGeocode = source === 'geocode';

    // Proximity gate — on the ANCHOR: a NAME that resolved implausibly far from what's currently on
    // screen is almost always a wrong geocoder match (e.g. "Texas Capitol grounds" → a west-Texas
    // admin region ~250 km away). Reject it — an honest "couldn't find it" beats a misleading
    // blob/point off in another region. Zoom-relative + floored so it only fires on egregious drift:
    // zoomed out, far-but-visible places still pass; zoomed way in, nearby landmarks stay safe.
    // Explicit coords / pixel picks / places / osm-local skip this (fromGeocode === false). The
    // footprint resolution below re-checks its own recentered centroid against the same bound — a
    // polygon that would drag a good anchor out of plausibility is dropped (the mark stays an
    // honest point) rather than rejecting the whole annotation.
    const vpGate = viewportProximity(viewer);
    const gateDrift = (gLat, gLon) => {
      if (!vpGate) return null; // no camera info → pass
      const driftKm =
        approximateDistanceM(vpGate.lat, vpGate.lon, gLat, gLon) / 1000;
      const limitKm = Math.max(
        VIEWPORT_DRIFT_FACTOR * vpGate.radiusKm,
        MIN_DRIFT_FLOOR_KM,
      );
      return driftKm > limitKm ? { driftKm, limitKm } : null;
    };
    if (fromGeocode && !bypassNearViewGuards && !allowDistant) {
      const drift = gateDrift(lat, lon);
      if (drift) {
        if (trace.query) {
          console.log(
            `[Resolver] "${trace.query}": places=${trace.places} geocode=${trace.geocode} ` +
              `osmSnap=${trace.osmSnap} → FINAL source=rejected (proximity gate, ${drift.driftKm.toFixed(0)}km > ${drift.limitKm.toFixed(0)}km)`,
          );
        }
        return null;
      }
    }

    // OSM name-matching key: the resolved feature's CANONICAL name when we have one — the
    // geocoder's primary component, else the Places hit's own display name — falling back to
    // the user's words. Canonical names strip the trailing locality ("Tejano Monument", not
    // "…, Austin"), so incidental city/state tokens can't win the footprint scoring (the
    // Thompson-Austin bug, field test 7). A POI's canonical name can be a bare street number,
    // so anything without letters falls through.
    const usablePrimary =
      geocodePrimary && /[a-z]/i.test(geocodePrimary) ? geocodePrimary : null;
    const usablePlaces =
      placesPrimary && /[a-z]/i.test(placesPrimary) ? placesPrimary : null;
    const matchName =
      usablePrimary || usablePlaces || String(target || '').trim();
    // Scope-route on the geocoder's type so we fetch the RIGHT OSM feature at the right size:
    // an admin boundary for a city/state, the enclosing compound for a mall/campus, a single
    // building for a premise. The voice model's entityKind (an entity FACT) refines an
    // unresolved 'auto' scope only — real geocode types always win.
    const baseScope = refineScope(scopeFromTypes(geocodeTypes), entityKind);
    // Point-like targets (monuments/statues/memorials/…) resolve POINT-FIRST: only an
    // (almost) exactly-named, monument-scale polygon may replace the point; a nearby polygon
    // sharing locality words must not (docs/field-test-rootcause-2026-06-30.md §1).
    const pointLike = isPointLikeTarget(
      target,
      entityKind,
      placeTypes,
      labelHint,
    );
    // Grounds/compound asks (target OR label wording, or entityKind fact) go outline-first:
    // they reach the real enclosing-polygon sweep even under `around_the_thing` phrasing.
    const groundsLike = isGroundsLikeAsk(target, labelHint, entityKind);

    /**
     * Resolve the footprint/outline for this (already-gated) anchor. Reads the outer locals
     * but never mutates them — tri-state result:
     *   - a complete outline patch `{ ring, footprintKind, buildingHeight, synthesized,
     *     lat, lon, height }` whose lat/lon is the ring centroid, re-checked against the
     *     proximity gate;
     *   - `null` — DEFINITIVELY no polygon (keep the honest point; never retry);
     *   - `undefined` — TRANSIENT upstream failure (timeout / network blip) — a re-run may
     *     yet find the outline, and the /api/overpass proxy caches late completions so the
     *     retry is nearly free (progressive callers back off and re-invoke).
     *   - `{ rateLimited:true, retryAfterMs }` — an HTTP throttle that progressive callers
     *     retry only once, no sooner than both Retry-After and their normal ladder allow.
     * The inline path awaits it right here; progressive callers (deferFootprint) invoke it
     * AFTER the anchor mark is drawn and upgrade the mark in place.
     */
    const resolveOutline = async () => {
      let scope = baseScope;
      const isAdmin =
        scope === 'country' ||
        scope === 'state' ||
        scope === 'county' ||
        scope === 'city';
      const around = intent === 'around_the_thing';
      // FIRST rung: bundled Natural Earth physical region (Alps, Rockies, Sahara,
      // Gulf of Mexico …) — deterministic, OFFLINE, instant; mirrors the
      // neighborhood-pack rung's philosophy. Two guards: (1) the ASK must NAME a
      // curated region (exact/alias match, no fuzzy stealing — "Zilker Park"
      // can never land here); (2) the geocoded anchor must fall INSIDE the
      // matched ring (ray-cast) — disambiguating duplicate upstream names (US
      // vs Spanish "Sierra Nevada") and blocking a wrong-place geocode from
      // dressing itself in a range-sized ring. Range-scale geometry deliberately
      // BYPASSES the compound/building scope caps and the centroid drift bound
      // below: the region IS the asked scope ("outline the Alps"), the 60 km²
      // compound cap is for campuses (the meadow bug,
      // docs/voice-engine-evaluation-2026-07-23.md §3), and a continental ring's
      // centroid legitimately sits far from any anchor. Admin and street scopes
      // are excluded — "Texas" must keep resolving as an admin boundary.
      if (!isAdmin && scope !== 'street' && !around) {
        const ne = await lookupNaturalRegionOutline(target, lat, lon).catch(
          () => null,
        );
        if (ne) {
          registerDynamicCredit(viewer, NATURAL_EARTH_CREDIT);
          const neCentroid = ringCentroid(ne.ring);
          return {
            ring: ne.ring,
            footprintKind: 'area',
            buildingHeight: null,
            synthesized: false,
            naturalRegion: ne.name,
            lat: neCentroid?.lat ?? lat,
            lon: neCentroid?.lon ?? lon,
            height: sampleGroundHeight(
              viewer,
              neCentroid?.lon ?? lon,
              neCentroid?.lat ?? lat,
            ),
          };
        }
      }
      let fp = null;
      if (
        around &&
        !groundsLike &&
        !isAdmin &&
        scope !== 'street' &&
        scope !== 'neighborhood'
      ) {
        // "the area AROUND <landmark>" → a buffered zone on the centroid, not the exact
        // footprint (research §3d / §8.5). Only for POI/building scopes — a city's or
        // street's "around" is ill-defined, a neighborhood already synthesizes, and a
        // GROUNDS-like ask must not short-circuit here: the model phrases "the Capitol
        // grounds" as around_the_thing, but the grounds ARE the thing — the real enclosing
        // polygon (below) beats a 400 m disc (field test 8's "spherical round one").
        const availability = await fetchEnclosingArea(
          lat,
          lon,
          signal,
          matchName,
        );
        if (
          isUnavailableCapability(availability) ||
          isRateLimitedOutcome(availability)
        )
          return availability;
        if (availability === undefined) return undefined;
        fp = synthesizeBufferedArea(lat, lon, AROUND_LANDMARK_RADIUS_M);
      } else if (isAdmin) {
        // Pure admin: only an admin boundary is correct — never fall back to a
        // building/landuse (a city is never a single building).
        fp = await fetchAdminArea(lat, lon, matchName, scope, signal);
      } else if (scope === 'neighborhood') {
        // FIRST: a bundled neighborhood polygon (reliable, deterministic, OFFLINE — no live
        // Overpass). Covered neighborhoods (e.g. SF: Chinatown/Marina/Mission/Presidio)
        // resolve here instantly to a REAL boundary, sidestepping the slow/flaky live-Overpass
        // path that times out and falls back to points (see docs/field-test-2-analysis.md).
        const ext = await lookupNeighborhoodRing(lat, lon, matchName);
        if (ext) fp = { ring: ext.ring, kind: 'area', heightM: null };
        // Else fall through to the OSM admin/place → named-landuse → synthesis ladder. Each
        // returns a footprint, null (definitively no polygon), or undefined (transient
        // upstream failure). Synthesize a blob (the "Mission" problem, research §3b) ONLY
        // when BOTH sources DEFINITIVELY have no polygon — never on a transient blip.
        if (!fp) {
          let adminFp = await fetchAdminArea(
            lat,
            lon,
            matchName,
            scope,
            signal,
          );
          // A neighborhood whose canonical name carries a city suffix ("Presidio of San
          // Francisco") can match the CITY admin; treat an oversized admin as a DEFINITIVE
          // no-neighborhood-polygon so it still falls through to the named-landuse path.
          if (isUnavailableCapability(adminFp)) return adminFp;
          if (adminFp && exceedsScopeArea(adminFp, scope)) adminFp = null;
          if (adminFp) {
            fp = adminFp;
          } else if (adminFp === null) {
            // Admin/place DEFINITIVELY has no neighborhood polygon → try a NAMED landuse, district-
            // sized (the Presidio, via the STRICT ≥0.3 km² gate).
            const footFp = await fetchFootprint(
              lat,
              lon,
              matchName,
              scope,
              signal,
              'strict',
            );
            if (isUnavailableCapability(footFp)) return footFp;
            if (footFp) {
              fp = footFp;
            } else if (footFp === null) {
              // Strict found no district-sized named area. Before drawing a buffered blob, try a
              // LOOSE footprint — a smaller named leisure/landuse polygon (e.g. Fort Mason, a
              // 0.26 km² NPS park that the strict 0.3 km² floor rejects but Google mis-types as a
              // "neighborhood") is a real outline and beats a disc. Name-match scoring keeps it from
              // grabbing a building; the scope cap below rejects anything oversized.
              const looseFp = await fetchFootprint(
                lat,
                lon,
                matchName,
                scope,
                signal,
                'loose',
              );
              if (isUnavailableCapability(looseFp)) return looseFp;
              if (looseFp && looseFp.kind !== 'building') fp = looseFp;
              else if (looseFp === null)
                fp = synthesizeBufferedArea(lat, lon, NEIGHBORHOOD_RADIUS_M);
              else if (looseFp === undefined) fp = undefined; // transient → honest point, retryable
              // a building (wrong feature) → leave fp null (honest point) rather than a
              // misleading blob — a re-run would only return the same cached building.
            } else {
              fp = undefined; // transient strict lookup → honest point, retryable
            }
          } else {
            // adminFp === undefined (transient in the HIGHER-priority admin/place leg): do NOT
            // fall through to a lower-priority landuse — a real boundary that was momentarily
            // unavailable must not be replaced by a lesser polygon. Honest point, retryable.
            fp = undefined;
          }
        }
      } else if (scope === 'street') {
        // Street → best-available AREA: a same-named district, else a buffered
        // corridor ribbon along the centerline (always works), never a building.
        fp = await fetchStreet(lat, lon, matchName, signal);
      } else {
        // compound / building / park / generic POI → the footprint resolver
        // (which classifies building-vs-area and stitches compound multipolygons).
        // Point-like targets use the strict 'point' selection: exact-ish name + monument
        // scale, else no polygon at all — the honest point beats a locality-word match.
        // Without a feature-name component, match the original ask and require
        // identity or containment before replacing its geocoded anchor.
        const footprintMode = pointLike
          ? 'point'
          : fromGeocode && !usablePrimary
            ? 'anchored'
            : 'loose';
        fp = await fetchFootprint(
          lat,
          lon,
          matchName,
          scope,
          signal,
          footprintMode,
        );
        // A "grounds/compound/campus" phrase ("Texas Capitol grounds") names an ENCLOSING area. The
        // primary footprint above returns the BUILDING (the dome) or null — neither is the grounds. The
        // real enclosing polygon (e.g. "Capitol Square", leisure=park) IS in OSM but only surfaces via a
        // radius sweep for NAMED non-building polygons, taking the SMALLEST that geometrically contains
        // the point (research docs/compound-containment-research.md §1.4–1.5). So when a grounds-like
        // query produced a building or no polygon, prefer that REAL enclosing outline; fall to a
        // synthesized disc only when OSM DEFINITIVELY has none.
        if (groundsLike && (fp === null || fp?.kind === 'building')) {
          const area = await fetchEnclosingArea(lat, lon, signal, matchName);
          if (isUnavailableCapability(area)) return area;
          if (area) {
            fp = area; // real grounds polygon (synthesized:false) — beats both the dome and a disc
            // It's a grounds/compound feature (already capped at SCOPE_AREA_CAP_M2.compound inside
            // fetchEnclosingArea). The geocoder may have typed the POI as `building` (the user pointed
            // at the dome), so validate against the COMPOUND cap below, not the tighter building one.
            scope = 'compound';
          } else if (area === null) {
            // OSM definitively has no enclosing polygon → loose dotted-disc footprint (the same
            // approximate-area treatment neighborhoods get), sized from the place viewport when
            // available (Places or geocode), else GROUNDS_RADIUS_M. A grounds ask never keeps the
            // bare BUILDING either: the dome is the exact feature, not the grounds — and under
            // progressive dedup an identical building ring would collapse into the building mark
            // and eat its caption. Never on `area === undefined` (transient — a retry may yet
            // find the real outline).
            fp = synthesizeBufferedArea(
              lat,
              lon,
              groundsRadiusFromViewport(placeViewport),
            );
          } else if (fp?.kind === 'building') {
            // Transient sweep failure with only the building in hand → honest point +
            // RETRYABLE (the backoff retry / a re-narration re-runs the sweep), never the
            // wrong exact-building shape.
            fp = undefined;
          }
        }
      }
      // Scope sanity: reject a real footprint whose area is wildly wrong for the asked
      // scope (a building/compound/neighborhood intent must never draw a state-sized
      // blob). Synthesized discs are deliberately sized and exempt.
      if (
        fp &&
        !fp.synthesized &&
        Array.isArray(fp.ring) &&
        fp.ring.length >= 3 &&
        exceedsScopeArea(fp, scope)
      ) {
        fp = null;
      }
      if (isUnavailableCapability(fp) || isRateLimitedOutcome(fp)) return fp;
      if (fp === undefined) return undefined; // TRANSIENT — a backoff retry may still find it
      if (!fp || !Array.isArray(fp.ring) || fp.ring.length < 3) return null;
      const centroid = ringCentroid(fp.ring);
      if (!centroid) return null;
      // Same drift bound as the anchor gate: a polygon whose centroid would drag a good
      // anchor out of plausibility is the wrong feature — drop it, keep the point.
      if (
        fromGeocode &&
        !bypassNearViewGuards &&
        gateDrift(centroid.lat, centroid.lon)
      )
        return null;
      return {
        ring: fp.ring,
        footprintKind: fp.kind,
        buildingHeight: fp.heightM,
        synthesized: Boolean(fp.synthesized),
        lat: centroid.lat,
        lon: centroid.lon,
        height: sampleGroundHeight(viewer, centroid.lon, centroid.lat),
      };
    };

    let ring = null;
    let footprintKind = null; // 'building' | 'area'
    let buildingHeight = null; // meters, only for buildings
    let outlineUnavailable = false;
    let synthesized = false; // true = buffered/approximate area, render dashed/feathered
    if (footprint && !deferFootprint) {
      const fp = await resolveOutline();
      outlineUnavailable = isUnavailableCapability(fp);
      if (fp && !outlineUnavailable && !isRateLimitedOutcome(fp)) {
        ring = fp.ring;
        footprintKind = fp.footprintKind;
        buildingHeight = fp.buildingHeight;
        synthesized = fp.synthesized;
        // Re-center the anchor on the resolved footprint centroid.
        lat = fp.lat;
        lon = fp.lon;
        source = 'footprint';
      }
    }

    const height = sampleGroundHeight(viewer, lon, lat);
    // One concise line per target so the resolution path is visible in the browser console.
    if (trace.query) {
      console.log(
        `[Resolver] "${trace.query}": places=${trace.places} geocode=${trace.geocode} ` +
          `osmSnap=${trace.osmSnap} → FINAL source=${source} ${lat.toFixed(5)},${lon.toFixed(5)}` +
          (footprint && deferFootprint ? ' (outline pending)' : ''),
      );
    }
    return {
      lon,
      lat,
      height,
      ring,
      footprintKind,
      buildingHeight,
      label,
      source,
      synthesized,
      outlineUnavailable,
      viewport: placeViewport,
      ...(footprint && deferFootprint ? { resolveOutline } : {}),
    };
  }

  // Upper area bound (m²) per scope. A resolved footprint bigger than its scope's
  // cap is the wrong feature (e.g. a whole city returned for a neighborhood), so we
  // drop it rather than draw a misleading blob. state / country / auto / street have
  // no cap (they are legitimately large or capped elsewhere).
  const SCOPE_AREA_CAP_M2 = {
    building: 0.6e6, // 0.6 km²
    compound: 60e6, // 60 km² (Presidio ≈ 6 km²; a mall ≈ 0.2 km²)
    neighborhood: 80e6, // 80 km²
    city: 9e9, // 9,000 km²
    county: 1.2e11, // 120,000 km²
  };

  // Proximity gate tolerances (see the gate in resolveAnnotationTarget). A geocoded anchor more
  // than VIEWPORT_DRIFT_FACTOR × the on-screen viewport radius away — but never less than
  // MIN_DRIFT_FLOOR_KM — is treated as a wrong match and rejected. The factor keeps it zoom-aware
  // (far-but-visible places pass when zoomed out); the floor avoids over-rejecting nearby places
  // when zoomed way in. The area cap alone can't catch this: admin scopes (state/country) are
  // uncapped, so a landmark that mis-geocodes to an admin region traces an uncapped blob.
  const VIEWPORT_DRIFT_FACTOR = 8;
  const MIN_DRIFT_FLOOR_KM = 50;

  // A view-biased Places Text Search hit is trusted only when it lands within this many metres of the
  // view centre — a sanity bound so a stray cross-city Text Search result can't anchor far from what
  // the user is looking at (it falls back to the geocode + osm-snap path instead). Generous enough to
  // cover a large compound's monuments seen from an oblique view (Text Search is biased to 6 km here).
  const PLACES_MAX_DISTANCE_M = 8000;

  // Synthesis radii (m) per osm-place-resolution-research.md §8.5. Used when OSM has only
  // a label point (most US neighborhoods) or the user asks for the area AROUND a landmark.
  const NEIGHBORHOOD_RADIUS_M = 750; // urban-neighborhood blob (600–900 m band)
  const AROUND_LANDMARK_RADIUS_M = 400; // "the area around X" — a few blocks (300–500 m)
  const GROUNDS_RADIUS_M = 300; // "X grounds/compound/campus" loose disc when OSM has no polygon
  const GROUNDS_RADIUS_MIN_M = 150; // viewport-derived grounds disc is clamped to this band so a tiny
  const GROUNDS_RADIUS_MAX_M = 1200; // place can't shrink to a dot, nor a city-wide viewport balloon

  /**
   * Synthesize an approximate circular AREA by buffering a label point. Returns a ring
   * marked `synthesized:true` so the renderers draw it "approximate" (dashed/feathered),
   * never as an authoritative boundary (research §8.6 invariant 3). Pure local math — no
   * Overpass call — so it always succeeds and adds no proxy/rate-limit cost.
   * @param {number} lat
   * @param {number} lon
   * @param {number} radiusM
   * @returns {{ring:[number,number][], kind:'area', heightM:null, synthesized:true}}
   */
  function synthesizeBufferedArea(lat, lon, radiusM) {
    const mPerDegLat = 111320;
    const mPerDegLon = mPerDegLat * Math.cos((lat * Math.PI) / 180);
    const ring = [];
    const N = 44;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      ring.push([
        lon + (Math.cos(a) * radiusM) / mPerDegLon,
        lat + (Math.sin(a) * radiusM) / mPerDegLat,
      ]);
    }
    return { ring, kind: 'area', heightM: null, synthesized: true };
  }

  /**
   * Radius (m) for a synthesized grounds disc, sized to the place's Google Places
   * `viewport` (a lat/lng box) when one is available: half its diagonal, clamped to
   * a sane band. Google never returns a polygon, but the viewport frames the real
   * feature, so this is far better than a blind constant. Falls back to
   * GROUNDS_RADIUS_M when there is no viewport.
   * @param {{low:{latitude:number,longitude:number},high:{latitude:number,longitude:number}}|null} viewport
   */
  function groundsRadiusFromViewport(viewport) {
    const lo = viewport?.low;
    const hi = viewport?.high;
    if (
      !lo ||
      !hi ||
      ![lo.latitude, lo.longitude, hi.latitude, hi.longitude].every(
        Number.isFinite,
      )
    ) {
      return GROUNDS_RADIUS_M;
    }
    const diagM = approximateDistanceM(
      lo.latitude,
      lo.longitude,
      hi.latitude,
      hi.longitude,
    );
    const r = diagM / 2;
    if (!Number.isFinite(r) || r <= 0) return GROUNDS_RADIUS_M;
    return Math.max(GROUNDS_RADIUS_MIN_M, Math.min(GROUNDS_RADIUS_MAX_M, r));
  }

  function exceedsScopeArea(fp, scope) {
    const cap = SCOPE_AREA_CAP_M2[scope];
    if (!cap) return false;
    return ringAreaM2(fp.ring) > cap;
  }

  /** Shoelace area (m²) of a [[lon,lat], ...] ring in a local equirectangular projection. */

  /** Resolve a name through the supplied service; geometry selection stays here. */
  async function geocodePlace(query, biasRect, signal, placeSearch) {
    const { place } = await placeSearch.geocode(query, {
      bias: biasRect,
      signal,
    });
    signal?.throwIfAborted();
    if (!place) return null;
    return {
      lat: place.lat,
      lon: place.lng,
      label: shortLabel(place.label),
      primaryName: place.name || null,
      types: place.types,
      viewport: normalizeGeocodeViewport(place.viewport),
    };
  }

  /** Geocoding returns {southwest:{lat,lng},northeast:{lat,lng}}; normalize to the Places
   *  {low,high} lat/lng shape the rest of the pipeline (disc sizing, framing) consumes. */
  function normalizeGeocodeViewport(vp) {
    const sw = vp?.southwest;
    const ne = vp?.northeast;
    if (![sw?.lat, sw?.lng, ne?.lat, ne?.lng].every(Number.isFinite))
      return null;
    return {
      low: { latitude: sw.lat, longitude: sw.lng },
      high: { latitude: ne.lat, longitude: ne.lng },
    };
  }

  let placesCaches = new WeakMap(); // Cache isolated by provider configuration

  /**
   * View-biased Google Places TEXT SEARCH for a named landmark/POI. Geocoding
   * scatters obscure monument/POI names across the city; a Text Search biased to
   * the view centre lands on the ACTUAL feature near what the user is looking at.
   * Goes through the `/api/google/text-search` proxy (key stays server-side) and
   * returns the closest result, or null on no-match / transient failure. The
   * `viewport` (a lat/lng bounding box framing the place, or null) is carried
   * through so the resolver can SIZE a fallback grounds disc to the real feature.
   * @returns {Promise<null | { lat:number, lon:number, label:string|null, distanceM:number,
   *   viewport:{low:{latitude:number,longitude:number},high:{latitude:number,longitude:number}}|null }>}
   */
  async function placesTextSearch(
    query,
    centerLat,
    centerLon,
    radiusM,
    signal,
    service = defaultGeospatial,
  ) {
    const placesCache = placesCaches.get(service) || new Map();
    placesCaches.set(service, placesCache);
    const q = String(query || '').trim();
    if (!q || !Number.isFinite(centerLat) || !Number.isFinite(centerLon))
      return null;

    const cacheKey = `${q.toLowerCase()}|${centerLat.toFixed(3)},${centerLon.toFixed(3)}|${radiusM}`;
    const cached = cacheRead(placesCache, cacheKey);
    if (cached !== undefined) return cached;

    try {
      const data = {
        places: await service.textSearch?.(
          q,
          {
            latitude: centerLat,
            longitude: centerLon,
            radiusM,
          },
          { signal },
        ),
      };
      const hit = Array.isArray(data?.places)
        ? data.places.find(
            (p) =>
              Number.isFinite(p?.latitude) && Number.isFinite(p?.longitude),
          )
        : null;
      if (!hit) {
        negCache(placesCache, cacheKey, signal, true);
        return null;
      } // definitive no-match
      const place = {
        lat: hit.latitude,
        lon: hit.longitude,
        label: hit.name || null,
        distanceM: approximateDistanceM(
          centerLat,
          centerLon,
          hit.latitude,
          hit.longitude,
        ),
        viewport: hit.viewport || null,
        // Entity identity/classification — the proxy already pays for these in its field
        // mask, so keep them: `primaryType`/`types` classify the feature (point-like
        // monument vs compound) and `id` is a stable identity key for future caching/dedup.
        id: hit.id || null,
        primaryType: hit.primaryType || null,
        types: Array.isArray(hit.types) ? hit.types : [],
      };
      cacheWrite(placesCache, cacheKey, place);
      return place;
    } catch {
      negCache(placesCache, cacheKey, signal, false); // network/abort — transient
      return null;
    }
  }

  /**
   * Map the Google geocode `types` to a resolution SCOPE so we fetch the right
   * OSM feature at the right size. Country-agnostic: scope only selects the query
   * strategy; the specific admin level is found by name within `is_in` results.
   */
  function scopeFromTypes(types) {
    const t = new Set((types || []).map((s) => String(s).toLowerCase()));
    if (t.has('country')) return 'country';
    if (t.has('administrative_area_level_1')) return 'state';
    if (
      t.has('administrative_area_level_2') ||
      t.has('administrative_area_level_3')
    )
      return 'county';
    if (t.has('locality') || t.has('postal_town')) return 'city';
    if (
      t.has('sublocality') ||
      t.has('sublocality_level_1') ||
      t.has('neighborhood')
    )
      return 'neighborhood';
    if (t.has('route') || t.has('intersection')) return 'street';
    if (t.has('premise') || t.has('subpremise') || t.has('street_address'))
      return 'building';
    if (
      t.has('shopping_mall') ||
      t.has('university') ||
      t.has('hospital') ||
      t.has('airport') ||
      t.has('park') ||
      t.has('stadium') ||
      t.has('amusement_park') ||
      t.has('campus') ||
      t.has('zoo') ||
      t.has('cemetery') ||
      t.has('tourist_attraction')
    )
      return 'compound';
    // Lakes / reservoirs / mountains: compound-sized natural areas (caps their footprint
    // at the 60 km² compound bound instead of leaving 'auto' uncapped).
    if (t.has('natural_feature')) return 'compound';
    return 'auto';
  }

  /**
   * Broad administrative scope explicitly stated by the ask, or null. Structured
   * entityKind facts take precedence over wording; every kind in today's voice tool
   * schema is non-admin, while the admin cases keep forward-compatible handling for
   * a future schema addition. Geocode result types are deliberately not an input.
   */
  function adminScopeFromAsk(target, entityKind) {
    if (typeof entityKind === 'string' && entityKind.trim()) {
      const kind = entityKind.trim().toLowerCase();
      return kind === 'country' || kind === 'state' || kind === 'county'
        ? kind
        : null;
    }

    const ask = String(target || '')
      .trim()
      .toLowerCase();
    if (/\b(?:country|nation)\s+of\s+\S/.test(ask)) return 'country';
    if (/^(?:the\s+)?state\s+of\s+\S/.test(ask)) return 'state';
    if (/\bcounty\s+of\s+\S/.test(ask) || /\bcounty$/.test(ask))
      return 'county';
    return null;
  }

  /**
   * Refine an UNRESOLVED ('auto') scope with the voice model's `entityKind` — the model's
   * statement of what kind of thing the target IS (an entity fact from the conversation,
   * not a render choice). Real geocode types are data and always win; entityKind only
   * fills the gap they leave (Places-sourced anchors never have geocode types, so they
   * are always 'auto' without this). 'point_feature' is handled by the point-first
   * contract (isPointLikeTarget), not by scope. Exported for tests.
   */
  function refineScope(scope, entityKind) {
    if (scope !== 'auto') return scope;
    if (entityKind === 'building') return 'building';
    if (entityKind === 'compound') return 'compound';
    if (entityKind === 'district') return 'neighborhood';
    if (entityKind === 'street') return 'street';
    return scope;
  }

  /** A distinct Overpass throttle result that must not enter the ordinary transient ladder. */
  function isRateLimitedOutcome(value) {
    return value?.rateLimited === true;
  }

  /**
   * Resolve an administrative boundary (country/state/county/city/neighborhood).
   * `is_in(point)` returns every admin area containing the point at all levels;
   * we pick the one whose NAME best matches the query (country-agnostic — no need
   * to know each country's admin_level mapping), pivot it to its relation, and
   * simplify the outline so even a state/country draws cleanly.
   */
  async function fetchAdminArea(lat, lon, query, scope, signal) {
    // Scope changes both the name-matching bias and the fallback strategy (only
    // neighborhood runs the place=/named-landuse fallback), so it must be in the key —
    // else a city-scope definitive null would suppress a later neighborhood lookup's
    // fetchPlaceArea recovery at the same rounded point.
    const cacheKey = `admin|${scope}|${lat.toFixed(4)},${lon.toFixed(4)}|${query.toLowerCase()}`;
    const cachedFp = cacheRead(footprintCache, cacheKey);
    if (cachedFp !== undefined) return cachedFp;

    const candidates = await featureSource.getAdministrativeAreas(
      { lat, lon },
      { signal: signal },
    );
    if (isUnavailableCapability(candidates) || isRateLimitedOutcome(candidates))
      return candidates;
    if (!candidates) return undefined; // transient upstream failure (vs null = definitive miss)

    const queryWords = normalizedWords(query);
    const scored = [];
    for (const el of candidates) {
      if (el.category !== 'administrative') continue;
      // Match against the FULL name set (incl. official_name) so the query can still hit a
      // verbose official name — but score COMPLETENESS against the CORE name only. A long
      // official_name ("City and County of San Francisco") otherwise DILUTES the real
      // boundary's completeness and lets a less-specific duplicate ("San Francisco County")
      // win — which then has no backing relation and collapses the whole resolution to a dot.
      const coreWords = normalizedWords(
        [el.names.primary, el.names.english].filter(Boolean).join(' '),
      );
      const fullWords = normalizedWords(
        [el.names.primary, el.names.english, el.names.official]
          .filter(Boolean)
          .join(' '),
      );
      const overlap = wordOverlap(queryWords, fullWords);
      if (!overlap) continue;
      const intentCoverage = queryWords.size ? overlap / queryWords.size : 0;
      // The matched admin area must BE (most of) what the user named — not just share an
      // incidental token ("Texas" inside "Texas State Capitol"). Require ≥ half the
      // canonical-name words, so a wrong-scope admin (the state) is rejected and the
      // footprint fallback gets a chance instead.
      if (intentCoverage < 0.5) continue;
      const coreOverlap = wordOverlap(queryWords, coreWords);
      const completeness = coreWords.size ? coreOverlap / coreWords.size : 0;
      // Exact-name bonus: the candidate whose CORE name set EQUALS the query is the real
      // one (decisively outranks a "<name> County" style duplicate).
      const exactName =
        coreWords.size === queryWords.size && coreOverlap === queryWords.size;
      const level = Number(el.level) || 99;
      // Bias toward the scope's specificity: city/neighborhood prefer the MORE specific
      // (higher admin_level) match; state/country prefer the broader one.
      let levelBias;
      if (scope === 'city' || scope === 'neighborhood') levelBias = level * 14;
      else if (scope === 'county') levelBias = -Math.abs(level - 6) * 14;
      else levelBias = -level * 14;
      const score =
        intentCoverage * 1200 +
        completeness * 500 +
        (exactName ? 900 : 0) +
        levelBias;
      scored.push({ el, score, coverage: intentCoverage });
    }
    // Deterministic order: score desc, then ascending OSM id. Overpass mirrors don't
    // guarantee element order, so without the id tiebreak a score tie could resolve
    // differently per mirror (breaks the "same name → same geometry" invariant).
    scored.sort((a, b) => b.score - a.score || a.el.id - b.el.id);

    const best = scored.length ? scored[0].el : null;
    const bestCoverage = scored.length ? scored[0].coverage : 0;

    // For a neighborhood, a place= polygon is the correct source. Try it whenever there
    // is NO admin match OR the admin only PARTIALLY covers the query — a small city can
    // satisfy a city-suffixed neighborhood ("Berkeley" for "Downtown Berkeley") at 0.5
    // coverage and slip under the area cap, so never accept such a partial admin
    // without first trying the place= polygon (and a named landuse via the caller).
    if (scope === 'neighborhood' && (!best || bestCoverage < 0.8)) {
      const place = await fetchPlaceArea(lat, lon, query, signal);
      if (isUnavailableCapability(place) || isRateLimitedOutcome(place))
        return place;
      if (place) {
        cacheWrite(footprintCache, cacheKey, place);
        return place;
      }
      if (place === undefined) return undefined; // transient place= lookup → don't cache, retry
      // Definitively no place polygon. Do NOT return a partial-match admin (likely the
      // wrong-scope city); let the caller try a named landuse / honest point.
      negCache(footprintCache, cacheKey, signal, true);
      return null;
    }
    if (!best) {
      negCache(footprintCache, cacheKey, signal, true); // got candidates, none matched → definitive
      return null;
    }

    // Walk candidates best-first until one pivots to a usable admin RELATION. The top
    // scorer can be a duplicate admin AREA with no backing relation (OSM's
    // "San Francisco County" duplicate); fall through to the next rather than giving up.
    // Cap at the top 4 so a pathological is_in (many overlapping admins) can't issue dozens
    // of pivots.
    let transient = false;
    for (const cand of scored.slice(0, 4)) {
      // Client budget must OUTLAST the QL timeout (25 s) + proxy transit: aborting at
      // 16 s turned finishable region pivots (Sicilia's dense coastline) into permanent
      // "transients" — every retry died the same death (field test 2026-07-23). The
      // outline is progressive, so a long budget blocks nothing; repeats are disk-cached.
      const relEls = await featureSource.getAreaGeometry(cand.el.id, {
        signal: signal,
      });
      if (isUnavailableCapability(relEls) || isRateLimitedOutcome(relEls))
        return relEls;
      if (relEls === null) {
        transient = true;
        break;
      } // network blip — don't definitively fail
      const relEl = relEls[0];
      if (!relEl) continue; // no relation backing this area — try the next candidate
      const coords = relEl.coordinates;
      if (coords.length < 3) continue; // incomplete geometry — try the next

      let ring = closeRing(coords.map((p) => [p.lon, p.lat]));
      // Simplify: tight for small neighborhoods, looser for states/countries.
      const tolM =
        scope === 'neighborhood'
          ? 6
          : scope === 'city'
            ? 12
            : scope === 'county'
              ? 40
              : 120;
      ring = simplifyRing(ring, tolM);
      const fp = { ring, kind: 'area', heightM: null };

      // Scope sanity BEFORE caching: a city-suffixed neighborhood name ("Downtown San
      // Francisco") can match the CITY admin. Caching an oversized ring would poison the
      // key and skip the place= fallback forever.
      if (exceedsScopeArea(fp, scope)) {
        if (scope === 'neighborhood') {
          const place = await fetchPlaceArea(lat, lon, query, signal);
          if (isUnavailableCapability(place) || isRateLimitedOutcome(place))
            return place;
          if (place) {
            cacheWrite(footprintCache, cacheKey, place);
            return place;
          }
          if (place === undefined) return undefined; // transient place= lookup → retry
          negCache(footprintCache, cacheKey, signal, true);
          return null;
        }
        continue; // oversized for this scope — try the next candidate
      }

      cacheWrite(footprintCache, cacheKey, fp);
      return fp;
    }
    // No candidate pivoted to a usable in-scope relation.
    if (transient) return undefined; // network blip during a pivot → don't cache, retry
    // For a neighborhood, an admin match may exist (so the early place= fallback above was
    // skipped) yet fail to yield a usable relation. Consult place= BEFORE declaring a
    // definitive miss, so a null return truly means "no admin AND no place polygon" — the
    // caller relies on that to gate named-landuse fallback / synthesis.
    if (scope === 'neighborhood') {
      const place = await fetchPlaceArea(lat, lon, query, signal);
      if (isUnavailableCapability(place) || isRateLimitedOutcome(place))
        return place;
      if (place) {
        cacheWrite(footprintCache, cacheKey, place);
        return place;
      }
      if (place === undefined) return undefined; // transient place= lookup → retry
    }
    negCache(footprintCache, cacheKey, signal, true);
    return null;
  }

  /**
   * Neighborhood fallback: OSM often tags neighborhoods as `place=` areas/relations
   * rather than admin boundaries. Query those near the point and match the canonical
   * name (area-capped so a "neighborhood" never grabs a whole city).
   */
  async function fetchPlaceArea(lat, lon, query, signal) {
    const queryWords = normalizedWords(query);
    const els = await featureSource.getNeighborhoodAreas(
      { lat, lon },
      { signal: signal },
    );
    if (isUnavailableCapability(els) || isRateLimitedOutcome(els)) return els;
    if (els === null) return undefined; // transient upstream failure (vs [] = no match)
    let bestRing = null;
    let bestScore = 0;
    for (const el of els) {
      const coords = el.coordinates;
      if (coords.length < 3) continue;
      const names = el.names;
      const nameWords = normalizedWords(
        [names.primary, names.english].filter(Boolean).join(' '),
      );
      const overlap = wordOverlap(queryWords, nameWords);
      if (!overlap) continue;
      // The OSM place name is usually just the neighborhood ("Downtown", "Chinatown")
      // while the query carries a city suffix ("Downtown San Francisco"). Match on how
      // fully the query covers the FEATURE'S name (not the query) — so a one-word place
      // whose name the query fully contains still wins — then prefer containment.
      const nameCoverage = nameWords.size ? overlap / nameWords.size : 0;
      if (nameCoverage < 0.6) continue;
      if (approximateAreaM2(coords) > 80_000_000) continue; // a neighborhood isn't a city
      const score =
        nameCoverage * 1000 +
        (pointInPolygon(lon, lat, coords) ? 400 : 0) +
        overlap * 50;
      if (score > bestScore) {
        bestScore = score;
        bestRing = closeRing(coords.map((p) => [p.lon, p.lat]));
      }
    }
    return bestRing ? { ring: bestRing, kind: 'area', heightM: null } : null;
  }

  /**
   * Street → best-available AREA, with graceful degradation:
   *   Tier C — a same-named district / commercial area near the street.
   *   Tier F — buffer the matching street centerline into a corridor ribbon.
   * Always returns an area (or null), never a building.
   */
  async function fetchStreet(lat, lon, query, signal) {
    const cacheKey = `street|${lat.toFixed(4)},${lon.toFixed(4)}|${query.toLowerCase()}`;
    const cachedFp = cacheRead(footprintCache, cacheKey);
    if (cachedFp !== undefined) return cachedFp;
    const queryWords = normalizedWords(query);

    // Tier C — a same-named district / quarter / named commercial area.
    const areaEls = await featureSource.getStreetAreas(
      { lat, lon },
      { signal: signal },
    );
    if (isUnavailableCapability(areaEls) || isRateLimitedOutcome(areaEls))
      return areaEls;
    if (areaEls) {
      let bestRing = null;
      let bestScore = 0;
      for (const el of areaEls) {
        const coords = el.coordinates;
        if (coords.length < 3) continue;
        const names = el.names;
        const nameWords = normalizedWords(
          [names.primary, names.english].filter(Boolean).join(' '),
        );
        const overlap = wordOverlap(queryWords, nameWords);
        if (!overlap) continue;
        if (approximateAreaM2(coords) > 2_000_000) continue; // a street isn't a whole suburb
        const score =
          overlap * 1000 + (pointInPolygon(lon, lat, coords) ? 300 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestRing = closeRing(coords.map((p) => [p.lon, p.lat]));
        }
      }
      if (bestRing) {
        const fp = { ring: bestRing, kind: 'area', heightM: null };
        cacheWrite(footprintCache, cacheKey, fp);
        return fp;
      }
    }

    // Tier F — buffer the matching centerline into a corridor ribbon (workhorse).
    const wayEls = await featureSource.getStreetLines(
      { lat, lon },
      { signal: signal },
    );
    if (isUnavailableCapability(wayEls) || isRateLimitedOutcome(wayEls))
      return wayEls;
    if (wayEls) {
      const segments = [];
      for (const el of wayEls) {
        const names = el.names;
        const nameWords = normalizedWords(
          [names.primary, names.english].filter(Boolean).join(' '),
        );
        if (!wordOverlap(queryWords, nameWords)) continue;
        const geom = el.coordinates;
        if (geom.length >= 2) segments.push(geom.map((p) => [p.lon, p.lat]));
      }
      if (segments.length) {
        const line = stitchLine(segments);
        if (line.length >= 2) {
          const fp = {
            ring: bufferCorridor(line, 11),
            kind: 'area',
            heightM: null,
          };
          cacheWrite(footprintCache, cacheKey, fp);
          return fp;
        }
      }
    }
    // Definitive only if BOTH tier queries actually returned data; a null from
    // either is a transient upstream failure we should not cache — and should
    // report as TRANSIENT (undefined) so the deferred-outline retry re-runs it.
    const definitive = areaEls !== null && wayEls !== null;
    negCache(footprintCache, cacheKey, signal, definitive);
    return definitive ? null : undefined;
  }

  /**
   * Fetch the best-matching OSM polygon near a point and classify it as a single
   * `building` (small footprint, gets extruded into a volume) or an `area` (a
   * named district / campus / compound / park, draped as a flat outline).
   *
   * Buildings are searched in a tight radius; areas use a wide radius because a
   * named compound like the Presidio (~6 km²) has its boundary nodes well over a
   * kilometre from the geocoded centroid. `out geom` returns full geometry for any
   * way/relation with a node inside the radius. NAMED water bodies (lakes /
   * reservoirs, `natural=water`) are first-class candidates: without them the true
   * feature for "Lady Bird Lake" is never in the set and a shoreline park NAMED
   * AFTER the lake wins on word overlap instead (field test 9).
   *
   * Selection `mode`:
   *   'loose'  — default word-overlap scoring (generic POIs/compounds).
   *   'strict' — named, non-building, district-sized areas only (neighborhood fallback).
   *   'point'  — point-like targets: (almost) exactly-named, monument-scale polygons only.
   *   'anchored' — address-only geocodes: require name identity or anchor containment.
   *
   * @returns {Promise<null | { ring: Array<[number,number]>, kind: 'building'|'area', heightM: number|null }>}
   */
  async function fetchFootprint(
    lat,
    lon,
    query,
    scope,
    signal,
    mode = 'loose',
  ) {
    // The resolution MODE changes what counts as a match, so it must be part of the
    // key — otherwise a loose lookup's building could be returned for a strict
    // neighborhood (or point-like) lookup at the same rounded coord/name, or vice-versa.
    const cacheKey = `fp|${mode}|${lat.toFixed(5)},${lon.toFixed(5)}|${query.toLowerCase()}`;
    const cachedFp = cacheRead(footprintCache, cacheKey);
    if (cachedFp !== undefined) return cachedFp;

    const elements = await featureSource.getFootprints(
      { lat, lon },
      { signal: signal },
    );
    if (isUnavailableCapability(elements) || isRateLimitedOutcome(elements))
      return elements;
    if (elements === null || signal?.aborted) return undefined;
    const fp = selectFootprint(elements, lat, lon, query, mode);
    if (fp) {
      cacheWrite(footprintCache, cacheKey, fp); // positive footprint — always cacheable
      return fp;
    }
    negCache(footprintCache, cacheKey, signal, true); // got a response, no match → definitive
    return null;
  }

  /**
   * Find the REAL enclosing "grounds / compound / campus" polygon containing a point
   * — the smallest NAMED, NON-building `leisure` / `landuse` / `boundary` / `amenity`
   * / `natural=water` polygon that geometrically CONTAINS it. (Water is in the sweep
   * because a lake asked for as a compound — "Lady Bird Lake", entityKind:compound —
   * anchors IN the water; without the tag it could never match.) This is "one level
   * up" the spatial
   * hierarchy from a building (e.g. the Texas Capitol dome → "Capitol Square",
   * leisure=park). OSM has no deterministic "parent polygon" call and the canonical
   * compound name is rarely what the user utters ("grounds", not "Capitol Square"),
   * so SELECTION is by containment → smallest area, with a name-match only as a
   * tiebreak BONUS (never a filter). See docs/compound-containment-research.md §1.4–1.5.
   *
   * Modeled on fetchLocalMonument: a 12 s fail-fast (an enrichment, not worth blocking
   * narration — and narration no longer waits on it since outlines went progressive, so
   * the budget can absorb a slow Overpass mirror instead of stranding the mark a point),
   * and the result cached by ~1 km coord bucket so a whole grounds batch costs ONE
   * query. Follows the file's tri-state convention:
   *   - `{ ring, kind:'area', heightM:null }` (synthesized:false — a REAL footprint),
   *   - `null` on a DEFINITIVE no-enclosing-polygon (got a response, nothing contained), or
   *   - `undefined` on a TRANSIENT Overpass failure (timeout / network — a retry may yet find it).
   *
   * @returns {Promise<undefined | null | { ring: Array<[number,number]>, kind: 'area', heightM: null }>}
   */
  async function fetchEnclosingArea(lat, lon, signal, query = '') {
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`; // ~1 km buckets — grounds annotations share one
    const cached = cacheRead(enclosingAreaCache, cacheKey);
    if (cached !== undefined) return cached;

    // Fail-fast budget: an opportunistic enrichment, not worth blocking on a hung Overpass —
    // but generous enough (12 s ≈ the footprint fetch budget) that an ordinary slow mirror
    // doesn't strand a grounds mark as a point. The feature source returns null on a transient
    // failure (timeout/502).
    const elements = await featureSource.getEnclosingAreas(
      { lat, lon },
      { signal: signal },
    );
    if (isUnavailableCapability(elements) || isRateLimitedOutcome(elements))
      return elements;
    if (elements === null) return undefined; // transient upstream failure (vs [] = definitive no-match)

    const queryWords = normalizedWords(query);
    let best = null; // smallest CONTAINING candidate
    let bestArea = Infinity;
    let bestNameMatch = false;
    for (const el of elements) {
      if (el.building) continue; // exclude buildings (the exact feature, never the grounds)
      const coords = el.coordinates;
      if (coords.length < 3) continue;
      if (!pointInPolygon(lon, lat, coords)) continue; // require genuine containment
      const ringLonLat = closeRing(coords.map((p) => [p.lon, p.lat]));
      const areaM2 = ringAreaM2(ringLonLat);
      if (areaM2 <= 0) continue;
      if (areaM2 > SCOPE_AREA_CAP_M2.compound) continue; // too big to be "the compound"
      // Name-match is a TIEBREAK BONUS, not a filter: at (near-)equal area, prefer a candidate the
      // user's words actually name. Smallest-area still dominates — containment + min-area is what
      // makes the Capitol land on "Capitol Square" even though the user said "grounds".
      const nameWords = normalizedWords(
        [
          el.names.primary,
          el.names.english,
          el.names.official,
          el.names.alternate,
        ]
          .filter(Boolean)
          .join(' '),
      );
      const nameMatch = wordOverlap(queryWords, nameWords) > 0;
      const better =
        areaM2 < bestArea * 0.999 ||
        (areaM2 <= bestArea * 1.05 && nameMatch && !bestNameMatch); // near-tie: name-match wins
      if (better) {
        best = { ring: ringLonLat, kind: 'area', heightM: null };
        bestArea = areaM2;
        bestNameMatch = nameMatch;
      }
    }

    // Cache on ANY definitive outcome (a real footprint OR a clean no-match) so a whole grounds batch
    // makes at most ONE call. A transient (`undefined`) already returned above without caching.
    if (best) {
      cacheWrite(enclosingAreaCache, cacheKey, best);
      return best;
    }
    negCache(enclosingAreaCache, cacheKey, signal, true); // got a response, nothing contained → definitive
    return null;
  }

  /** A target that reads like a fine-grained monument/marker (vs a building/district). */
  function isMonumentLikeQuery(query) {
    return /\b(monument|memorial|statue|sculpture|fountain|cenotaph|obelisk|plaque|bust)\b/i.test(
      String(query || ''),
    );
  }

  /** A target that reads like an enclosing GROUNDS / COMPOUND / CAMPUS (e.g. "Texas Capitol grounds")
   *  rather than a single building — used to synthesize a loose-footprint disc when OSM has no real
   *  polygon, instead of failing outright. */
  function isGroundsLikeQuery(query) {
    return /\b(grounds|compound|campus|complex|quad|plaza)\b/i.test(
      String(query || ''),
    );
  }

  /**
   * Whether a target is a POINT-LIKE cultural marker (monument/statue/memorial/plaque/…)
   * that must resolve point-first (field test 7 §1). Classification ladder, most
   * authoritative first:
   *   1. the voice model's explicit `entityKind` (an entity fact — trusted both ways),
   *   2. grounds-like wording in the target OR label (area intent) vetoes,
   *   3. the monument wordlist,
   *   4. the Places `types` of the anchored feature (data — present on places-sourced
   *      anchors; 'monument'/'sculpture' are unambiguous point classes).
   */
  function isPointLikeTarget(target, entityKind, placeTypes, label) {
    if (entityKind === 'point_feature') return true;
    if (entityKind) return false; // model asserted an area-like kind (building/compound/…)
    if (isGroundsLikeQuery(target) || isGroundsLikeQuery(label)) return false;
    if (isMonumentLikeQuery(target)) return true;
    const t = new Set((placeTypes || []).map((s) => String(s).toLowerCase()));
    return t.has('monument') || t.has('sculpture');
  }

  /**
   * Whether an annotation asks for an enclosing GROUNDS / COMPOUND / CAMPUS area. The model
   * often puts the grounds word in the LABEL, not the target ("target: Texas State Capitol,
   * label: Capitol grounds" — field test 8), so both count; an explicit `entityKind` (entity
   * fact) is trusted both ways. Grounds-like asks reach the REAL enclosing-polygon sweep even
   * under `around_the_thing` phrasing — the thing named IS the grounds, so a buffered
   * around-disc would be the wrong shape. Exported for tests.
   */
  function isGroundsLikeAsk(target, label, entityKind) {
    if (entityKind) return entityKind === 'compound';
    return isGroundsLikeQuery(target) || isGroundsLikeQuery(label);
  }

  /**
   * Find the actual OSM monument/memorial/statue NEAR a view centre, name-matched. Google geocodes
   * these obscure names unreliably (it scatters several Capitol-grounds monuments across the city),
   * so for a monument-like target we anchor on what the user is LOOKING AT and snap to the real
   * feature. The Overpass result set is cached by rounded centre, so a whole batch of monuments on
   * one set of grounds costs a SINGLE query. Returns {lat, lon, label} on a name match, else null
   * (no match, or a transient/timed-out Overpass) → the caller keeps the geocode point.
   */
  const monumentInflight = new Map(); // centerKey → in-flight sweep promise (batch dedup)

  async function fetchLocalMonument(lat, lon, query, signal) {
    const centerKey = `${lat.toFixed(2)},${lon.toFixed(2)}`; // ~1 km buckets — grounds monuments share one
    let features = cacheRead(monumentCache, centerKey);
    if (features === undefined) {
      // One sweep per bucket even under the engine's CONCURRENT batch resolution: every
      // monument in an annotate() batch awaits the same in-flight promise. The shared fetch
      // deliberately ignores the callers' abort signals (it is bounded by its own 6 s
      // timeout, and one caller's clear() must not kill the others' snap).
      let pending = monumentInflight.get(centerKey);
      if (!pending) {
        // Short timeout + fail-fast: this is an opportunistic snap, not worth blocking narration
        // on a slow/overloaded Overpass. The feature source returns null on a transient failure.
        pending = featureSource
          .getMonuments({ lat, lon }, { signal: undefined })
          .then((elements) => {
            if (
              elements === null ||
              isUnavailableCapability(elements) ||
              isRateLimitedOutcome(elements)
            )
              return null; // transient — NEVER cached (a poisoned bucket
            // would silently disable the snap for the whole session, field test 7 §1)
            const feats = [];
            for (const el of elements) {
              const name =
                el.names.primary ||
                el.names.english ||
                el.names.official ||
                el.names.alternate;
              if (!name) continue;
              const p = el.point;
              if (!p) continue;
              feats.push({
                name,
                lat: p.lat,
                lon: p.lon,
                words: normalizedWords(name),
              });
            }
            // Definitive outcome (Overpass answered, possibly with zero features) → cacheable.
            cacheWrite(monumentCache, centerKey, feats);
            return feats;
          })
          .finally(() => monumentInflight.delete(centerKey));
        monumentInflight.set(centerKey, pending);
      }
      features = await pending;
      if (features === null) return null; // transient sweep failure → keep the geocode anchor, retry next call
    }
    if (!features.length) return null;
    const qWords = normalizedWords(query);
    if (!qWords.size) return null;
    // Best match: the feature whose name is MOSTLY covered by the query (so "Tejano Monument"
    // doesn't match "Texas African American History Memorial", and a bare "the monument" matches
    // nothing). completeness = how much of the feature name the query accounts for.
    let best = null;
    let bestScore = 0;
    for (const f of features) {
      const overlap = wordOverlap(f.words, qWords);
      if (!overlap) continue;
      const completeness = f.words.size ? overlap / f.words.size : 0;
      if (completeness < 0.6) continue;
      const score = overlap * 10 + completeness;
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best ? { lat: best.lat, lon: best.lon, label: best.name } : null;
  }

  // Point-like footprint ceiling: big enough for the large DC-style memorial complexes
  // (Lincoln Memorial ≈ 7k m², WWII / 9-11 Memorial plazas ≈ 30k m²), far too small for
  // the park/campus that CONTAINS a monument (Golden Gate Park ≈ 4.1M m²).
  const POINTLIKE_AREA_CAP_M2 = 60_000;

  /**
   * Pick the best OSM polygon for a query from raw Overpass elements. `mode` selects the
   * acceptance contract ('loose' | 'strict' | 'point' | 'anchored' — see fetchFootprint). Exported for
   * the unit tests, which pin the mode contracts with fixtures captured from live data.
   */
  function selectFootprint(
    elements,
    targetLat,
    targetLon,
    query,
    mode = 'loose',
  ) {
    const requireName = mode === 'strict';
    const queryWords = normalizedWords(query);
    let best = null;
    let bestScore = -Infinity;

    for (const element of elements) {
      const coords = element.coordinates;
      if (coords.length < 3) continue;

      const names = element.names;
      const isBuilding = element.building;
      const areaM2 = approximateAreaM2(coords);

      const nameWords = normalizedWords(
        [
          names.primary,
          names.english,
          names.official,
          names.alternate,
          names.short,
        ]
          .filter(Boolean)
          .join(' '),
      );
      const nameOverlap = wordOverlap(queryWords, nameWords);
      // How completely the query covers this feature's name (1.0 ≈ exact match).
      const completeness = nameWords.size ? nameOverlap / nameWords.size : 0;
      const named = nameOverlap > 0;
      // Admin/neighborhood fallback (requireName): accept only a NAMED, non-building
      // AREA of district size (≥0.3 km², e.g. the Presidio's landuse). A neighborhood
      // is never a single building or a tiny parcel, so a building named "Mission ..."
      // or a 0.01 km² lot must not stand in for it — better an honest labeled point.
      if (requireName && (!named || isBuilding || areaM2 < 300_000)) continue;
      // Point-like contract: a polygon may stand in for a monument/statue/memorial ONLY
      // when it clearly IS that feature — most of the query names it (intentCoverage) AND
      // the query accounts for most of ITS name (completeness) AND it is monument-scale.
      // Bare word overlap must not qualify: "Thompson Austin" shares only the locality
      // token with "Tejano Monument, Austin" and outscored everything under loose scoring
      // (field test 7 §1). No qualifying polygon → null → the honest point anchor stays.
      if (mode === 'point') {
        const intentCoverage = queryWords.size
          ? nameOverlap / queryWords.size
          : 0;
        if (!named || intentCoverage < 0.5 || completeness < 0.6) continue;
        if (areaM2 > POINTLIKE_AREA_CAP_M2) continue;
      }

      // Size gating: buildings are small; areas can be large but only when named
      // (so "Presidio" can match a 6 km² compound without grabbing a whole city).
      if (isBuilding) {
        if (areaM2 < 40 || areaM2 > 400_000) continue;
      } else {
        if (areaM2 < 200) continue;
        if (!named && areaM2 > 600_000) continue;
        if (named && areaM2 > 80_000_000) continue;
      }

      const contains = pointInPolygon(targetLon, targetLat, coords);
      if (mode === 'anchored' && !contains) {
        const intentCoverage = queryWords.size
          ? nameOverlap / queryWords.size
          : 0;
        if (!named || intentCoverage < 0.5 || completeness < 0.6) continue;
      }
      const centroid = ringCentroid(coords.map((p) => [p.lon, p.lat]));
      const distanceM = centroid
        ? approximateDistanceM(targetLat, targetLon, centroid.lat, centroid.lon)
        : 9999;

      // Name match dominates; completeness breaks ties so the feature literally
      // named "Presidio" beats a building that merely contains the word. Size is
      // only a mild tiebreak now (no hard penalty against large named areas).
      let score =
        nameOverlap * 1000 +
        completeness * 600 +
        (contains ? 450 : 0) -
        distanceM * 0.25 -
        Math.sqrt(areaM2) * 0.05;

      // With no name match at all, prefer a precise building over a vague blob.
      if (!named && isBuilding && contains) score += 250;

      if (score > bestScore) {
        bestScore = score;
        best = {
          ring: closeRing(coords.map((p) => [p.lon, p.lat])),
          kind: isBuilding ? 'building' : 'area',
          heightM: isBuilding
            ? (element.heightM ??
              Math.max(10, Math.min(70, Math.sqrt(Math.max(1, areaM2)) * 0.6)))
            : null,
        };
      }
    }

    return best;
  }

  function normalizedWords(value) {
    return new Set(
      String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 2),
    );
  }

  function wordOverlap(left, right) {
    let matches = 0;
    for (const word of left) {
      if (right.has(word)) matches++;
    }
    return matches;
  }

  // --- viewer helpers ---------------------------------------------------------

  /**
   * Current view rectangle as a Google `bounds` string `swLat,swLng|neLat,neLng`,
   * used to bias geocoding toward what the user is looking at.
   */
  /**
   * The current view as a center + radius (km), feeding the geocode proximity gate: a named place
   * that resolved much farther than this radius from center is rejected as a wrong match.
   *
   * Center is the CAMERA SUBPOINT (its lon/lat), not the view-rectangle center — the subpoint is
   * always available, whereas computeViewRectangle() returns undefined exactly when the user is in
   * the common low/oblique view with the horizon in frame (which is when the bad geocodes bite).
   * Radius is scaled from camera height (a generous proxy for how much ground is on screen), with a
   * floor so a super-zoomed-in view doesn't over-reject genuinely nearby places.
   */
  function viewportProximity(viewer) {
    try {
      const carto = viewer?.camera?.positionCartographic;
      if (!carto) return null;
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const radiusKm = Math.max((carto.height / 1000) * 3, 5);
      if (![lat, lon, radiusKm].every(Number.isFinite)) return null;
      return { lat, lon, radiusKm };
    } catch {
      return null;
    }
  }

  /** Exported for searchAndFlyTo (src/locations.js), which shares this bias. */
  function viewportBias(viewer) {
    try {
      const rect = viewer?.camera?.computeViewRectangle?.();
      if (!rect) return null;
      const swLat = Cesium.Math.toDegrees(rect.south).toFixed(4);
      const swLng = Cesium.Math.toDegrees(rect.west).toFixed(4);
      const neLat = Cesium.Math.toDegrees(rect.north).toFixed(4);
      const neLng = Cesium.Math.toDegrees(rect.east).toFixed(4);
      if ([swLat, swLng, neLat, neLng].some((v) => v === 'NaN')) return null;
      return `${swLat},${swLng}|${neLat},${neLng}`;
    } catch {
      return null;
    }
  }

  /**
   * View-biased Places recovery for a NAME whose geocode missed or landed implausibly
   * far from what the user is looking at — the searchAndFlyTo twin of the recovery
   * inside resolveAnnotationTarget ("the Capitol" → Washington DC while hovering
   * Austin). When there is no geocode, or it sits more than MIN_DRIFT_FLOOR_KM from
   * the view centre, a Places Text Search biased to the view centre is trusted within
   * PLACES_MAX_DISTANCE_M. A near geocode returns null untouched — local hits keep the
   * plain geocode path. Returns the Places hit
   * ({ lat, lon, label, types, viewport, distanceM, … }) or null.
   */
  async function placesNearViewRecovery(
    viewer,
    query,
    geocoded = null,
    signal = undefined,
    placeSearch = defaultGeospatial,
  ) {
    const center =
      pickWorldFromScreen(viewer, 0.5, 0.5) || viewportProximity(viewer);
    if (!center) return null;
    const geocodeFar =
      !geocoded ||
      approximateDistanceM(center.lat, center.lon, geocoded.lat, geocoded.lon) /
        1000 >
        MIN_DRIFT_FLOOR_KM;
    if (!geocodeFar) return null;
    const hit = await placesTextSearch(
      query,
      center.lat,
      center.lon,
      6000,
      signal,
      placeSearch,
    );
    return hit && hit.distanceM <= PLACES_MAX_DISTANCE_M ? hit : null;
  }

  /**
   * Convert a NORMALIZED screen point (x,y in [0,1] of the current viewport) into
   * a world lon/lat using the depth-aware pick cascade — the inverse of the
   * project-to-screen used by the renderers. This is the "point at the pixel"
   * fallback: the agent indicates a spot in the viewport screenshot when it can't
   * name the place, and we anchor the mark to the actual world point under it.
   */
  function pickWorldFromScreen(viewer, nx, ny) {
    const scene = viewer?.scene;
    if (!scene) return null;
    const canvas = scene.canvas;
    const w = canvas.clientWidth || canvas.width || 0;
    const h = canvas.clientHeight || canvas.height || 0;
    if (!w || !h) return null;
    const px = Math.max(0, Math.min(1, nx)) * w;
    const py = Math.max(0, Math.min(1, ny)) * h;
    const pos = new Cesium.Cartesian2(px, py);

    // Each stage is validated before it is accepted: a depth pick over empty sky
    // can return a NaN or centre-of-the-earth Cartesian, and converting one of
    // those throws inside Cesium. A degenerate pick IS a missed pick, so it falls
    // through to the next stage and ultimately to the caller's null.
    let cart = null;
    if (
      scene.pickPositionSupported &&
      typeof scene.pickPosition === 'function'
    ) {
      try {
        cart = scene.pickPosition(pos);
      } catch {
        cart = null;
      }
    }
    if (
      !isPickedWorldPosition(cart) &&
      typeof viewer.camera.pickEllipsoid === 'function'
    ) {
      try {
        cart = viewer.camera.pickEllipsoid(pos, Cesium.Ellipsoid.WGS84);
      } catch {
        cart = null;
      }
    }
    if (
      !isPickedWorldPosition(cart) &&
      typeof viewer.camera.getPickRay === 'function'
    ) {
      try {
        const ray = viewer.camera.getPickRay(pos);
        cart = ray ? scene.globe?.pick(ray, scene) || null : null;
      } catch {
        cart = null;
      }
    }
    if (!isPickedWorldPosition(cart)) return null;
    const carto = Cesium.Cartographic.fromCartesian(cart);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      // The height the pick actually landed on — a roof, a hillside, or 0 on
      // the ellipsoid. Callers that only want a coordinate ignore it; the draw
      // tool's live preview needs it, or the rubber band sinks to sea level
      // while the pointer is on a hill.
      height: Number.isFinite(carto.height) ? carto.height : 0,
    };
  }

  /**
   * Best-effort ground height at a coordinate. The Cesium globe is hidden behind
   * the Google 3D tiles, so we try to clamp onto the photoreal tile surface; if
   * the tiles for that spot aren't loaded we fall back to the ellipsoid (0).
   */
  function sampleGroundHeight(viewer, lon, lat) {
    const scene = viewer?.scene;
    if (!scene) return 0;
    try {
      if (
        scene.clampToHeightSupported &&
        typeof scene.clampToHeight === 'function'
      ) {
        const carto = Cesium.Cartographic.fromDegrees(lon, lat);
        const surface = Cesium.Cartographic.toCartesian(carto);
        const clamped = scene.clampToHeight(surface);
        if (clamped) {
          const h = Cesium.Cartographic.fromCartesian(clamped).height;
          if (Number.isFinite(h)) return h;
        }
      }
    } catch {
      /* tiles not ready — fall through */
    }
    const globeHeight = scene.globe?.getHeight?.(
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    return Number.isFinite(globeHeight) && globeHeight > 0 ? globeHeight : 0;
  }

  function shortLabel(formattedAddress) {
    if (!formattedAddress) return null;
    return String(formattedAddress).split(',')[0].trim() || null;
  }

  /**
   * Region ring for ANALYST queries ("how many flights over Texas / the Alps") —
   * a name-only entry point that reuses this module's boundary machinery
   * without the annotation pipeline. Natural Earth pack first (offline,
   * instant; largest-area match is correct for a global name-only ask), then
   * geocode + admin boundary for states/countries/counties (Tier A disk-cached
   * Overpass, so repeat asks are instant). Returns null when the name doesn't
   * resolve to a region-like boundary — the analyst engine reports that
   * honestly rather than silently scoping to nothing.
   *
   * The geocode + admin-boundary rung is capped at `budgetMs`. Past it the
   * call returns `{name, ring: null, error: 'region-timeout'}` so a voice
   * answer is not held for tens of seconds; the lookup keeps running and
   * fills the boundary cache, so asking again shortly is fast.
   *
   * @param {string} name  e.g. "Texas", "the Alps", "France", "Gulf of Mexico"
   * @param {AbortSignal} [signal]
   * @param {object} [placeSearch]
   * @param {{budgetMs?: number}} [options]  `Infinity` waits for the lookup.
   * @returns {Promise<{name:string, ring:Array<[number,number]>}|{name:string, ring:null, error:'region-timeout'}|null>}
   */
  async function resolveRegionRingForQuery(
    name,
    signal,
    placeSearch = unavailablePlaceSearch,
    { budgetMs = REGION_FALLBACK_BUDGET_MS } = {},
  ) {
    signal = lifetime
      ? signal
        ? AbortSignal.any([lifetime, signal])
        : lifetime
      : signal;
    signal?.throwIfAborted();
    const q = String(name || '').trim();
    if (!q) return null;
    const ne = await findNaturalRegion(q).catch(() => null);
    if (ne?.polygons?.length) {
      // Largest ring carries the query scope; multi-ring regions (Andes) keep
      // their main cordillera — good enough for containment counting.
      const ring = [...ne.polygons].sort((a, b) => b.length - a.length)[0];
      if (ring?.length >= 3) return { name: ne.name, ring };
    }
    const lookup = resolveAdminRegionRing(q, signal, placeSearch);
    if (!Number.isFinite(budgetMs)) return lookup;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ name: q, ring: null, error: 'region-timeout' }),
        budgetMs,
      );
    });
    try {
      return await Promise.race([lookup, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveAdminRegionRing(q, signal, placeSearch) {
    const geo = await geocodePlace(q, null, signal, placeSearch).catch(
      () => null,
    );
    if (!geo) return null;
    const scope = scopeFromTypes(geo.types);
    if (!['country', 'state', 'county', 'city'].includes(scope)) return null;
    const fp = await fetchAdminArea(geo.lat, geo.lon, q, scope, signal).catch(
      () => null,
    );
    if (fp?.ring?.length >= 3) return { name: q, ring: fp.ring };
    return null;
  }

  lifetime?.addEventListener(
    'abort',
    () => {
      footprintCache.clear();
      monumentCache.clear();
      enclosingAreaCache.clear();
      placesCaches = new WeakMap();
      monumentInflight.clear();
    },
    { once: true },
  );
  return {
    resolveAnnotationTarget,
    refineScope,
    isRateLimitedOutcome,
    isGroundsLikeAsk,
    selectFootprint,
    viewportBias,
    placesNearViewRecovery,
    resolveRegionRingForQuery,
    // Scene helpers, not resolution: the manual draw tool turns a click into a
    // world point with the same depth-aware cascade the agent's pixel fallback
    // uses, and the engine samples the surface under a hand-placed mark. Both
    // are exposed so there is ONE pick cascade in the app, not a second one
    // written beside it.
    pickWorldFromScreen,
    sampleGroundHeight,
  };
}
