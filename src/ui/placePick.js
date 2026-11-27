import { greatCircleKm } from '../geoDistance.js';
import {
  findAirport,
  findPickedAirport,
  foldName,
  isAirportCountryCode,
  isAirportCode,
  namesAirport,
} from '../data/airports.js';
import { layerRecordsNear, recordTitle } from '../data/entityContext.js';
import { parseCoordinateQuery } from '../search/coordinateParser.js';
import { BASES_LAYER, baseIdentity, placeIdentity } from './placeCard.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { PLACE_PICK_EVENT } from './contextEvents.js';

/** How far from where a search landed a base it names may be. */
const BASE_MATCH_KM = 5;
/** How near an airport a search for its bare code must land. */
const CODE_LANDED_KM = 100;
/** How near a picked spot an airport must be for the spot to be the airport. */
const AT_AIRPORT_KM = 5;
const AIRPORT_WAIT_MS = 5000;

/**
 * The card a found search opens: an airport the line names (its
 * code or catalog name) from the bundled pack; a base the line
 * names that Military Installations has loaded near where the search
 * landed; else the place itself, with the name the search found. A picked
 * spot (`picked`: a row that named its own place and position) opens an
 * airport only when it is at the airport, or names an airport near it, so
 * "SFO" in Tølløse opens Tølløse.
 * @param {{query: string, label?: string, lat: number, lon: number, picked?: boolean, framed?: boolean}} found
 * @param {{dataManager?: object, airportWaitMs?: number, findAirport?: (query: string, near: {lat: number, lon: number}) => Promise<object|null>}} [deps]
 * @returns {Promise<{identity: object, fly: boolean}|null>}
 */
export async function placeForSearch(
  { query, label, lat, lon, picked = false, framed = false },
  { dataManager = null, findAirport: lookUp = findAirport, airportWaitMs } = {},
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const country = isAirportCountryCode(query);
  const named = namesAirport(label);
  let airport = null;
  if (
    query?.trim() &&
    !parseCoordinateQuery(query) &&
    (picked || !country || named)
  ) {
    // Plain text can be an exact catalog name. Give it only a short wait
    // while the shared pack loads; explicit airport searches can wait longer.
    const wait =
      airportWaitMs ??
      (isAirportCode(query) || namesAirport(query) || named
        ? AIRPORT_WAIT_MS
        : 250);
    let timer;
    try {
      airport = await Promise.race([
        lookUp(query, { lat, lon }),
        new Promise((resolve) => {
          timer = setTimeout(resolve, wait, null);
        }),
      ]);
    } catch {
      // The place result is still usable when the airport pack is unavailable.
    } finally {
      clearTimeout(timer);
    }
  }
  const away = airport ? greatCircleKm({ lat, lon }, airport) : Infinity;
  const namedAirport =
    named || (airport?.name && foldName(label) === foldName(airport.name));
  const codeHolds = picked
    ? away <= AT_AIRPORT_KM || (namedAirport && away <= CODE_LANDED_KM)
    : (!country && airport?.size === 'large') || away <= CODE_LANDED_KM;
  if (airport && codeHolds)
    return {
      identity: placeIdentity({ airport }),
      fly: !(framed && away <= AT_AIRPORT_KM),
    };
  const siteName = foldName(query);
  if (/[\p{L}\p{N}]{3}/u.test(siteName)) {
    let bases = [];
    try {
      bases = layerRecordsNear(
        dataManager,
        BASES_LAYER,
        { lat, lon },
        BASE_MATCH_KM,
      );
    } catch {
      bases = [];
    }
    const base = bases.find(
      ({ record }) => foldName(recordTitle(record)) === siteName,
    );
    if (base) return { identity: baseIdentity(base.record), fly: false };
  }
  return {
    identity: placeIdentity({ name: label || query, lat, lon, from: 'search' }),
    fly: false,
  };
}

/**
 * Announce a place pick. With no coordinates, the location search's own
 * result for the same query places it. Coordinates without a query are a
 * picked spot; `airport` is the code or catalog ident of the airport a row named.
 * `framed` means the caller has already sent the camera to these coordinates.
 * @param {{name?: string, latitude?: number, longitude?: number, query?: string, airport?: string, framed?: boolean, isCurrent?: () => boolean}} place
 */
export function announcePlacePick(place) {
  if (typeof CustomEvent !== 'function') return;
  globalThis.document?.dispatchEvent?.(
    new CustomEvent(PLACE_PICK_EVENT, { detail: { ...place } }),
  );
}

const finiteNumber = (value) =>
  value !== null && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

/**
 * Open a place's card in Context when a place is picked (PLACE_PICK_EVENT).
 * A location search alone opens nothing; its last result places a pick that
 * named only its query. Routing stays here, outside the omnibar.
 * @param {object} options
 * @param {object} options.pinia
 * @param {(listener: Function) => (() => void)} [options.subscribe] The
 *   location search's state channel (`subscribeLocationSearch`).
 * @param {(listener: Function) => (() => void)} [options.subscribeCameraHandoff]
 *   Invalidates pending picks when a newer navigation takes the camera.
 * @param {() => object} options.getDataManager
 * @param {EventTarget} [options.target] Where picks are announced.
 * @param {() => void} [options.creditAirports] Called when an airport's card
 *   opens (the bundled OurAirports pack's courtesy credit).
 * @returns {() => void} disconnects
 */
export function installPlacePick({
  pinia,
  subscribe,
  subscribeCameraHandoff,
  getDataManager,
  target = globalThis.document,
  creditAirports = null,
}) {
  const store = useEntityCardStore(pinia);
  let generation = 0;
  let stopped = false;
  const offNavigation = subscribeCameraHandoff?.(() => {
    generation++;
    store.cancelPendingLocate();
  });
  // The last place a location search found, for a pick that names a query.
  let lastFound = null;
  const offSearch = subscribe?.(({ state, change }) => {
    if (change?.type === 'started') lastFound = null;
    if (change?.type === 'found')
      lastFound = {
        query: state?.query || '',
        destination: state?.destination,
      };
  });
  const onPick = async (event) => {
    const detail = event?.detail || {};
    let lat = finiteNumber(detail.latitude);
    let lon = finiteNumber(detail.longitude);
    let label = detail.name || '';
    // A row that named its own spot: what it opens is that spot.
    const picked = lat !== null && lon !== null && !detail.query;
    if (
      (lat === null || lon === null) &&
      lastFound &&
      (!detail.query || lastFound.query === detail.query)
    ) {
      lat = finiteNumber(lastFound.destination?.latitude);
      lon = finiteNumber(lastFound.destination?.longitude);
      label = lastFound.destination?.label || label;
    }
    if (lat === null || lon === null) return;
    store.cancelPendingLocate();
    const mine = ++generation;
    // A pick made while the place was looked up (an aircraft clicked, say)
    // is newer than this one: the place card does not replace it.
    const selectionAtPick = store.selectionGeneration();
    const ownsPick = store.claimDeferredPick();
    const found = await placeForSearch(
      {
        query: detail.airport || detail.query || label,
        label,
        lat,
        lon,
        picked,
        framed: detail.framed === true,
      },
      {
        dataManager: getDataManager?.(),
        ...(detail.airport && {
          findAirport: findPickedAirport,
          airportWaitMs: AIRPORT_WAIT_MS,
        }),
      },
    ).catch(() => null);
    if (stopped || mine !== generation || !ownsPick() || !found) return;
    // The caller may also have started another action while this resolved.
    if (detail.isCurrent?.() === false) return;
    if (store.selectionGeneration() !== selectionAtPick) return;
    if (found.identity.place?.airport) creditAirports?.();
    store.select(found.identity, { fly: found.fly, follow: false });
  };
  target?.addEventListener?.(PLACE_PICK_EVENT, onPick);
  return () => {
    stopped = true;
    offSearch?.();
    offNavigation?.();
    target?.removeEventListener?.(PLACE_PICK_EVENT, onPick);
  };
}
