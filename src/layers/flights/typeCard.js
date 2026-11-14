import { aircraftTypeEntry } from '../../data/aircraftTypes/index.js';
import { airlineForCallsign } from '../../data/airlines/index.js';
import { countryForIcao24 } from '../../data/countries/index.js';

/**
 * @module typeCard
 * @description Pure model behind the selected-aircraft type card: what kind of
 * aircraft the tracked contact is (name, specs, a licensed photo of the TYPE)
 * plus its live telemetry, the operator airline and the country of registry.
 * The library imports live only here.
 */

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value) => String(value ?? '').trim() || null;

function specsOf(entry) {
  const source = entry.specs ?? {};
  const specs = {
    lengthM: finiteOrNull(source.lengthM),
    spanM: finiteOrNull(source.spanM),
    engines: finiteOrNull(source.engines),
    engineType: textOrNull(source.engineType),
    firstFlightYear: finiteOrNull(source.firstFlightYear),
  };
  return Object.values(specs).some((value) => value !== null) ? specs : null;
}

function photoOf(entry) {
  const photo = entry.photo;
  if (!photo?.path) return null;
  return {
    path: photo.path,
    author: textOrNull(photo.author),
    licence: textOrNull(photo.licence),
    licenceUrl: textOrNull(photo.licenceUrl),
    sourceUrl: textOrNull(photo.sourceUrl),
    cropped: photo.cropped === true,
  };
}

/**
 * @param {object} record Tracked-contact descriptor as `getTrackedInfo()`
 *   returns it (callsign, registration, icao24, typeCode, altitudeM,
 *   velocityMps, track, latitude, longitude, origin, destination).
 * @param {{isMilitary: boolean}} options Faction of the contact.
 * @returns {{
 *   faction: 'civil'|'military',
 *   identity: {callsign: string|null, registration: string|null,
 *     icao24: string|null, typeCode: string|null},
 *   type: {name: string, manufacturer: string|null, class: string|null}|null,
 *   specs: {lengthM: number|null, spanM: number|null, engines: number|null,
 *     engineType: string|null, firstFlightYear: number|null}|null,
 *   photo: {path: string, author: string|null, licence: string|null,
 *     licenceUrl: string|null, sourceUrl: string|null, cropped: boolean}|null,
 *   telemetry: {altitudeM: number|null, speedMs: number|null,
 *     headingDeg: number|null, lat: number|null, lon: number|null,
 *     origin: string|null, destination: string|null},
 *   operator: {name: string, icao: string, iata: string|null,
 *     callsign: string|null, tailColor: string|null}|null,
 *   country: {iso2: string, name: string, flag: string}|null,
 * }} `type`, `specs` and `photo` are null for a type the library lacks.
 *   `operator` is null when the callsign names no airline, and `country` is
 *   null when the ICAO 24-bit address sits in no allocated block.
 */
export function aircraftTypeCardModel(record, { isMilitary }) {
  const info = record ?? {};
  const entry = aircraftTypeEntry(info.typeCode);
  return {
    faction: isMilitary ? 'military' : 'civil',
    identity: {
      callsign: textOrNull(info.callsign),
      registration: textOrNull(info.registration),
      icao24: textOrNull(info.icao24),
      typeCode: textOrNull(info.typeCode),
    },
    type: entry
      ? {
          name: entry.name,
          manufacturer: textOrNull(entry.manufacturer),
          class: textOrNull(entry.class),
        }
      : null,
    specs: entry ? specsOf(entry) : null,
    photo: entry ? photoOf(entry) : null,
    telemetry: {
      altitudeM: finiteOrNull(info.altitudeM),
      speedMs: finiteOrNull(info.velocityMps),
      headingDeg: finiteOrNull(info.track),
      lat: finiteOrNull(info.latitude),
      lon: finiteOrNull(info.longitude),
      origin: textOrNull(info.origin),
      destination: textOrNull(info.destination),
    },
    operator: (() => {
      const a = airlineForCallsign(info.callsign);
      return a
        ? {
            name: a.name,
            icao: a.icao,
            iata: a.iata,
            callsign: a.callsign,
            tailColor: a.tailColor,
          }
        : null;
    })(),
    country: (() => {
      const c = countryForIcao24(info.icao24);
      return c ? { iso2: c.iso2, name: c.name, flag: c.flag } : null;
    })(),
  };
}
