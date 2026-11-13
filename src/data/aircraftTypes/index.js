/**
 * @file Bundled aircraft type library: ICAO type designator -> name, class,
 * specs and a licensed photo. Built by scripts/build-aircraft-catalog.mjs;
 * bundled so it works with no network.
 */

import catalog from './catalog.json' with { type: 'json' };
import { classifyAircraft } from '../aircraftClass.js';

const BY_ICAO = new Map(catalog.map((entry) => [entry.icao, entry]));

const normalise = (typeCode) =>
  String(typeCode ?? '')
    .trim()
    .toUpperCase();

/**
 * @param {unknown} typeCode ICAO type designator, any case, may be padded.
 * @returns {object|null} catalog entry, or null for an unknown designator.
 */
export function aircraftTypeEntry(typeCode) {
  return BY_ICAO.get(normalise(typeCode)) ?? null;
}

/**
 * Class for the shape and glyph: the catalog's class when the type is known,
 * which may correct classifyAircraft, otherwise classifyAircraft's.
 * @param {unknown} typeCode
 * @returns {string}
 */
export function aircraftTypeClass(typeCode) {
  return (
    aircraftTypeEntry(typeCode)?.class ??
    classifyAircraft({ typeCode: normalise(typeCode) })
  );
}
