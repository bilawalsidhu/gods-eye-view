import { normalizeRadioCountryInput } from '../../data/radioCountry.js';
import { RADIO_UUID_RE } from './policy.js';

export function createCatalogModel({
  state: layerState,
  services,
  parts,
  source,
}) {
  function isNonGlobalRadioIpv4(hostname) {
    const pieces = hostname.split('.');
    if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece)))
      return false;
    const values = pieces.map(Number);
    if (values.some((value) => value > 255)) return true;
    const [a, b, c] = values;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  function isSafeRadioHttpsUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
      const url = new URL(value);
      const hostname = url.hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !hostname
      )
        return false;
      return !(
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        isNonGlobalRadioIpv4(hostname) ||
        hostname.includes(':')
      );
    } catch {
      return false;
    }
  }

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
    isNonGlobalRadioIpv4,
    isSafeRadioHttpsUrl,
    isValidRadioDirectoryStation,
    freezeRadioStation,
    createAcceptedCatalogSnapshot,
  };
}
