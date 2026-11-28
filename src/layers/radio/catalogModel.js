import { normalizeRadioCountryInput } from '../../data/radioCountry.js';
import { publicRadioHttpsUrl } from '../../sources/radioBrowser.js';
import { RADIO_UUID_RE } from './policy.js';

/** A public HTTPS URL string; non-strings fail rather than being stringified. */
const isSafeRadioHttpsUrl = (value) =>
  typeof value === 'string' && publicRadioHttpsUrl(value) !== null;

export function createCatalogModel({
  state: layerState,
  services,
  parts,
  source,
}) {
  function isValidRadioDirectoryStation(station) {
    const cleanText = (value, maxLength, { allowEmpty = true } = {}) =>
      typeof value === 'string' &&
      value.length <= maxLength &&
      (allowEmpty || value.trim().length > 0) &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value === value.trim() &&
      !/\s{2,}/.test(value);
    const textArray = (value, limit, itemMaxLength) =>
      Array.isArray(value) &&
      value.length <= limit &&
      value.every((item) =>
        cleanText(item, itemMaxLength, { allowEmpty: false }),
      );
    return Boolean(
      station &&
      RADIO_UUID_RE.test(station.id) &&
      cleanText(station.name, 140, { allowEmpty: false }) &&
      Number.isFinite(station.lat) &&
      station.lat >= -90 &&
      station.lat <= 90 &&
      Number.isFinite(station.lon) &&
      station.lon >= -180 &&
      station.lon <= 180 &&
      isSafeRadioHttpsUrl(station.streamUrl) &&
      (station.homepage === null || isSafeRadioHttpsUrl(station.homepage)) &&
      textArray(station.tags, 24, 80) &&
      textArray(station.languages, 8, 40) &&
      cleanText(station.state, 80) &&
      cleanText(station.country, 80) &&
      cleanText(station.countryCode, 2) &&
      (station.countryCode === '' ||
        normalizeRadioCountryInput(station.countryCode).valid) &&
      station.metadataTrust === 'untrusted-community' &&
      cleanText(station.codec, 16, { allowEmpty: false }) &&
      /^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(station.codec) &&
      (station.bitrate === null ||
        (Number.isInteger(station.bitrate) &&
          station.bitrate >= 8 &&
          station.bitrate <= 1024)),
    );
  }

  function freezeRadioStation(station) {
    return Object.freeze({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      streamUrl: station.streamUrl,
      homepage: station.homepage,
      tags: Object.freeze([...station.tags]),
      languages: Object.freeze([...station.languages]),
      state: station.state,
      country: station.country,
      countryCode: station.countryCode,
      metadataTrust: station.metadataTrust,
      codec: station.codec,
      bitrate: station.bitrate,
    });
  }

  function createAcceptedCatalogSnapshot(
    instance,
    generation,
    updatedAt,
    stations,
  ) {
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    if (typeof instance !== 'string' || !instance) return null;
    const frozenStations = Object.freeze(stations.map(freezeRadioStation));
    return Object.freeze({
      instance,
      generation,
      updatedAt,
      stations: frozenStations,
      stationIds: Object.freeze(frozenStations.map((station) => station.id)),
    });
  }
  return {
    isValidRadioDirectoryStation,
    freezeRadioStation,
    createAcceptedCatalogSnapshot,
  };
}
