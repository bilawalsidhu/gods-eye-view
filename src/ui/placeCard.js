import { airportsNear, NEAR_AIRPORT_KM } from '../data/airports.js';
import {
  recordKey,
  recordPosition,
  recordTitle,
} from '../data/entityContext.js';
import { norm180, norm360, toDegrees } from '../geo/vector.js';
import { bearingBetweenCoordinates, relativeBearing } from '../cockpitMath.js';
import { pinMap } from './mapTiles.js';
import { msg } from '../i18n/marker.js';
import { getLocale, t } from '../i18n/index.js';
import { countryName } from '../data/wikidataCities.js';

/**
 * Places and spots in Context. A place picked from search
 * gets a card of its own; so does an airport, from the bundled OurAirports
 * pack, which is part of picking a place rather than a layer. A spot (a
 * click on empty ground, or a place) can be pinned as a still with a map.
 * A base is the Military Installations layer's own record and opens its
 * card; it is never copied here.
 */

/** The card store's layer id for places: not a layer anyone turns on. */
export const PLACE_LAYER = 'place';
/** The Military Installations layer, whose records are the bases. */
export const BASES_LAYER = 'military-installations';
/** How far an airport card looks for the flights coming and going. */
export const AIRPORT_TRAFFIC_KM = 50;
const FT_TO_M = 0.3048;

const fixed = (n) => (Number.isFinite(n) ? n.toFixed(4) : 'x');

/**
 * A place's identity for the card store and for its pin. An airport goes by
 * its code, so finding it again (search, a near link, a pin) is the same
 * card; any other place by where it is.
 * @param {{name?: string, lat: number, lon: number, from?: 'search'|'spot', airport?: object|null}} place
 */
export function placeIdentity({
  name = '',
  lat,
  lon,
  from = 'search',
  airport = null,
}) {
  const id = airport
    ? `airport:${airport.ident}`
    : `${fixed(lat)},${fixed(lon)}`;
  return {
    layerId: PLACE_LAYER,
    id,
    label: airport?.name || name || '',
    lat: airport ? airport.lat : lat,
    lon: airport ? airport.lon : lon,
    place: { from: airport ? 'airport' : from, airport: airport || null },
  };
}

/** The card key a place's identity makes. */
export const placeKey = (identity) => `${PLACE_LAYER}:${identity?.id || ''}`;

/** "30.2610, −97.7454": a spot's coordinates as its place line shows them. */
export function spotCoordinates(lat, lon, format = (n) => n.toFixed(4)) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  return `${format(lat)}, ${format(lon)}`;
}

/**
 * The card for a place, in the shape `describeEntity` gives every card, so
 * the card, its pin and Nearby treat it as any other item that stays put.
 * Its facts (an airport's codes, elevation and runways) go under More
 * details; the figures on top are the card's own (EntityCard).
 * @param {ReturnType<typeof placeIdentity>} identity
 */
export function describePlace(identity) {
  if (
    identity?.layerId !== PLACE_LAYER ||
    !Number.isFinite(identity.lat) ||
    !Number.isFinite(identity.lon)
  )
    return null;
  const place = identity.place || { from: 'search', airport: null };
  const airport = place.airport || null;
  const codes =
    airport &&
    [
      ...new Set(
        [airport.iata, airport.icao || airport.ident]
          .filter(Boolean)
          .map((code) => code.toUpperCase()),
      ),
    ].join(' · ');
  const facts = [];
  if (airport) {
    if (codes)
      facts.push({ field: 'codes', label: msg('Codes'), value: codes });
    if (airport.city)
      facts.push({ field: 'city', label: msg('City'), value: airport.city });
    if (Number.isFinite(airport.elevationFt)) {
      const elevationM = Math.round(airport.elevationFt * FT_TO_M);
      facts.push({
        field: 'elevation',
        label: msg('Elevation'),
        value: `${elevationM} m`,
        words: {
          text: '{n} m',
          values: { n: elevationM },
        },
      });
    }
    if (airport.runways)
      facts.push({
        field: 'runways',
        label: msg('Runways'),
        value: String(airport.runways),
      });
  }
  const title = airport
    ? `${airport.name}${codes ? ` (${codes})` : ''}`
    : identity.label || '';
  return {
    key: placeKey(identity),
    layerId: PLACE_LAYER,
    layerName: 'Places',
    kind: airport ? 'airport' : 'place',
    icon: airport ? 'local_airport' : 'location_on',
    moving: false,
    headline: [],
    title,
    // A spot without a name goes by what it is.
    titleWords: title ? null : { text: msg('Picked spot') },
    lat: identity.lat,
    lon: identity.lon,
    altitudeM: null,
    facts,
    warnings: [],
    warningWords: [],
    aircraftClass: null,
    modelSubject: null,
    photo: null,
    aircraftClassName: null,
    countryCode: null,
    insights: [],
    operator: null,
    heading: null,
    speedMps: null,
    route: null,
    links: [],
    get source() {
      return airport ? t('OurAirports · bundled') : '';
    },
    basis: 'place',
    identity: {
      layerId: PLACE_LAYER,
      id: identity.id,
      label: identity.label,
      lat: identity.lat,
      lon: identity.lon,
      place,
    },
    place,
  };
}

/**
 * Loaded flights within AIRPORT_TRAFFIC_KM, grouped nearest first. Route
 * endpoints determine arrivals and departures unless both are this airport.
 * Otherwise motion is used for nearby flights with no route or a return
 * route. The guessed and unknown counts distinguish estimates from missing
 * flight data.
 * @param {Array<{record: object, km: number}>} near From `recordsNear`.
 * @param {object} airport
 * @param {{slowing?: (record: object) => boolean}} [options] Whether a
 *   flight on the ground has slowed since it was last read (see
 *   `groundSpeedTrend`); never, without it.
 * @returns {{arriving: Array<{record: object, km: number, guessed?: boolean}>,
 *   departing: Array<{record: object, km: number, guessed?: boolean}>,
 *   other: Array<{record: object, km: number}>, guessed: number, unknown: number}}
 */
export function airportTraffic(near, airport, { slowing = () => false } = {}) {
  const codes = new Set(
    [airport?.iata, airport?.icao, airport?.ident]
      .filter(Boolean)
      .map((code) => code.toUpperCase()),
  );
  const same = (code) => Boolean(code) && codes.has(String(code).toUpperCase());
  const arriving = [];
  const departing = [];
  const other = [];
  let guessed = 0;
  let unknown = 0;
  for (const entry of near || []) {
    const { record } = entry;
    if (
      record?.aircraftClass === 'vehicle' ||
      record?.aircraftClass === 'station'
    )
      continue;
    const toHere = same(record?.routeDestination);
    const fromHere = same(record?.routeOrigin);
    if (toHere && !fromHere) arriving.push(entry);
    else if (fromHere && !toHere) departing.push(entry);
    else if (!toHere && (record?.routeOrigin || record?.routeDestination))
      other.push(entry);
    else {
      const guess = guessTraffic(entry, airport, slowing);
      if (guess) guessed++;
      if (guess === 'unknown') unknown++;
      if (guess === 'arriving') arriving.push({ ...entry, guessed: true });
      else if (guess === 'departing')
        departing.push({ ...entry, guessed: true });
      else other.push(entry);
    }
  }
  return { arriving, departing, other, guessed, unknown };
}

/** How near an airport a flight without a route is judged as its traffic. */
export const AIRPORT_GUESS_KM = 30;
/** How near a flight on the ground is taken to be at this airport. */
export const AIRPORT_GROUND_KM = 5;
/** How high above the field a flight is still taken to be coming or going: 10,000 ft. */
const GUESS_CEILING_M = 3048;
/** A climb or descent this fast or faster counts: about 300 ft a minute. */
const CLIMB_MPS = 1.5;
/** Within this of the airport's point a climb is away from it whatever the heading. */
const LIFT_OFF_KM = 3;
/** A change in ground speed this large or larger counts as slowing or speeding up. */
const SPEED_STEP_MPS = 1;
const STOPPED_MPS = 1;
const PARKED_READINGS = 5;

/**
 * A routeless flight near an airport: 'arriving', 'departing', 'nearby'
 * (it moves, but neither way), 'unknown' (no altitude or climb or descent
 * to judge by), or null when it is too far or too high to be this
 * airport's.
 */
function guessTraffic({ record, km }, airport, slowing) {
  if (record?.onGround === true) {
    if (!(km <= AIRPORT_GROUND_KM)) return null;
    return slowing(record) ? 'arriving' : 'nearby';
  }
  if (!(km <= AIRPORT_GUESS_KM)) return null;
  const altitude = record?.altitudeM;
  const rate = record?.verticalRateMps;
  const fieldM = Number.isFinite(airport?.elevationFt)
    ? airport.elevationFt * FT_TO_M
    : 0;
  if (Number.isFinite(altitude) && altitude - fieldM > GUESS_CEILING_M)
    return null;
  if (!Number.isFinite(altitude) || !Number.isFinite(rate)) return 'unknown';
  if (rate <= -CLIMB_MPS)
    return km > LIFT_OFF_KM && headingAway(record, airport)
      ? 'nearby'
      : 'arriving';
  if (rate >= CLIMB_MPS && (km <= LIFT_OFF_KM || headingAway(record, airport)))
    return 'departing';
  return 'nearby';
}

/** Whether a flight's heading takes it farther from the airport. */
function headingAway(record, airport) {
  const at = recordPosition(record);
  const inward = bearingBetweenCoordinates(
    at?.lat,
    at?.lon,
    airport?.lat,
    airport?.lon,
  );
  const off = relativeBearing(inward, record?.heading);
  return off !== null && Math.abs(off) > 90;
}

/**
 * Remembers each flight's ground speed between reads, so an airport card can
 * tell one on the ground that is slowing (just landed) from one taxiing or
 * parked. A flight keeps its trend until its speed moves by SPEED_STEP_MPS,
 * except that five fresh stopped readings clear a landing estimate. Undated
 * feeds use successive reads for this cutoff.
 */
export function groundSpeedTrend() {
  const seen = new Map();
  const keyOf = (record) => String(record?.icao24 || record?.id || '');
  return {
    /** Note the speeds of the flights on the ground in `near`. */
    note(near) {
      const now = new Set();
      for (const { record } of near || []) {
        const key = keyOf(record);
        const speed = record?.speedMps;
        if (!key || record?.onGround !== true || !Number.isFinite(speed))
          continue;
        now.add(key);
        const was = seen.get(key);
        const at = Number.isFinite(record.lastContactAtMs)
          ? record.lastContactAtMs
          : null;
        if (!was || Math.abs(speed - was.speed) >= SPEED_STEP_MPS) {
          seen.set(key, {
            speed,
            slowing: Boolean(was && speed < was.speed),
            at,
            stopped: 0,
          });
        } else if (at === null || at !== was.at) {
          was.at = at;
          was.stopped =
            speed < STOPPED_MPS && was.slowing ? was.stopped + 1 : 0;
          if (was.stopped >= PARKED_READINGS) was.slowing = false;
        }
      }
      for (const key of seen.keys()) if (!now.has(key)) seen.delete(key);
    },
    /** Whether that flight's ground speed last moved down. */
    slowing(record) {
      return seen.get(keyOf(record))?.slowing === true;
    },
    clear() {
      seen.clear();
    },
  };
}

export function baseIdentity(record) {
  const at = recordPosition(record);
  return {
    layerId: BASES_LAYER,
    id: record.id,
    label: recordTitle(record),
    lat: at.lat,
    lon: at.lon,
  };
}

/**
 * The airport or base a spot is near (within NEAR_AIRPORT_KM), for the place
 * line's "near" link; the nearest of the two, or null. Airports come from
 * the bundled pack; bases only from what Military Installations has loaded,
 * so nothing is asked for.
 * @param {number} lat
 * @param {number} lon
 * @param {(layerId: string, lat: number, lon: number, km: number) => Array<{record: object, km: number}>} recordsNear
 * @returns {Promise<null|{kind: 'airport', airport: object, km: number}|{kind: 'base', identity: object, name: string, km: number}>}
 */
export async function nearSite(lat, lon, recordsNear) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const [airport] = await airportsNear(lat, lon, NEAR_AIRPORT_KM);
  let base = null;
  try {
    const [found] = recordsNear(BASES_LAYER, lat, lon, NEAR_AIRPORT_KM);
    if (found) base = found;
  } catch {
    base = null;
  }
  const baseName = base ? recordTitle(base.record) : '';
  if (base && baseName && (!airport || base.km < airport.distanceKm)) {
    return {
      kind: 'base',
      name: baseName,
      km: base.km,
      identity: baseIdentity(base.record),
    };
  }
  return airport ? { kind: 'airport', airport, km: airport.distanceKm } : null;
}

/**
 * A pin for a place: a still with a map, its name and where it is. Tapping
 * it flies there (the card store's `open`).
 * @param {ReturnType<typeof placeIdentity>} identity
 * @param {string} title
 */
export function placePin(identity, title) {
  return {
    key: placeKey(identity),
    kind: 'place',
    title,
    icon: identity.place?.airport ? 'local_airport' : 'location_on',
    identity,
    map: pinMap(identity.lat, identity.lon),
  };
}

/** The selected Space Mission always pins its launch site as a place. */
export function missionSitePin(mission) {
  if (!Number.isFinite(mission?.lat) || !Number.isFinite(mission?.lon))
    return null;
  const { lat, lon, site, title } = mission;
  const name = site || title;
  return placePin(placeIdentity({ name, lat, lon, from: 'spot' }), name);
}

export function viewPlaceName(place) {
  if (!place) return t('This view');
  const { name } = place;
  const country = countryName(place.country, getLocale());
  const label = country && country !== name ? `${name}, ${country}` : name;
  return t('Near {place}', { place: label });
}

/** Localize generated view names at render time; preserve other saved names. */
export function pinTitle(pin) {
  return pin.kind === 'view' && Object.hasOwn(pin, 'viewPlace')
    ? viewPlaceName(pin.viewPlace)
    : pin.title;
}

/**
 * The view itself as a pin, from Context's place header: the camera as it
 * is (position, heading, pitch, roll) and the place's name, so its tile
 * flies back to the same view. Made from what the header already has: no
 * request.
 * @param {{center: {lat: number, lon: number}, pose: object}} view
 * @param {{name: string, country: string}|null} place The place under the view.
 */
export function viewPin(view, place) {
  const { center, pose } = view || {};
  if (!center || ![pose?.lat, pose?.lon, pose?.height].every(Number.isFinite))
    return null;
  const at = `${fixed(center.lat)},${fixed(center.lon)}`;
  // Use a stable key without rounding the pose stored for the return flight.
  const angle = (value) =>
    norm360(
      Number.isFinite(value) ? Math.round(toDegrees(value) * 100) / 100 : 0,
    );
  const poseKey = [
    fixed(pose.lat),
    fixed(norm180(pose.lon)),
    Math.round(pose.height),
    angle(pose.heading),
    angle(pose.pitch),
    angle(pose.roll),
  ].join(',');
  const viewPlace = place ? { name: place.name, country: place.country } : null;
  const name = viewPlaceName(viewPlace);
  return {
    key: `view:${at}@${poseKey}`,
    kind: 'view',
    title: name,
    viewPlace,
    icon: 'location_on',
    identity: {
      layerId: 'view',
      id: at,
      label: name,
      lat: center.lat,
      lon: center.lon,
    },
    pose: {
      lon: pose.lon,
      lat: pose.lat,
      height: pose.height,
      heading: pose.heading,
      pitch: pose.pitch,
      roll: pose.roll,
    },
    map: pinMap(center.lat, center.lon),
  };
}

/**
 * A loaded flight as a Nearby row (NearbyLists' shape), so a tap opens its
 * card like any other row.
 * @param {string} layerId
 * @param {{record: object, km: number}} entry
 */
export function nearbyRow(layerId, { record, km }) {
  const key = recordKey(layerId, record);
  return {
    key,
    layerId,
    title: recordTitle(record) || key,
    distanceKm: km,
    identity: {
      layerId,
      id: key.slice(layerId.length + 1),
      label: recordTitle(record),
      ...recordPosition(record),
      record,
    },
  };
}
