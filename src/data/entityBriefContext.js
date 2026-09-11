/**
 * @module entityBriefContext
 * Builds a Gemini-safe payload from a context-store record.
 */

import { weatherCodeLabel } from './regionalBrief.js';
import {
  assetCountLabel,
  estimateBoundsAreaKm2,
  formatBoundsSummary,
  groupContactsForBrief,
  summarizeAssetCounts,
} from './intelAreaContext.js';

const LAYER_TITLES = Object.freeze({
  flights: 'Aircraft',
  military: 'Military aircraft',
  'military-flights': 'Military aircraft',
  'ais-live-vessels': 'Vessel',
  satellites: 'Satellite',
  'rocket-launches': 'Rocket launch',
  cctv: 'Public camera',
  radio: 'Radio station',
  firms: 'Active fire',
  earthquakes: 'Earthquake',
  'local-datacenters': 'Datacenter',
  'local-dams': 'Dam',
  'telegeography-submarine-cables': 'Submarine cable',
  'local-firms': 'Active fire',
  'military-installations': 'Mapped installation',
});

const PREFERRED_PROPERTY_KEYS = [
  'callsign',
  'registration',
  'type',
  'typeCode',
  'aircraftClass',
  'operator',
  'owner',
  'shipType',
  'destination',
  'routeOrigin',
  'routeDestination',
  'magnitude',
  'frp',
  'name',
  'provider',
  'city',
  'country',
  'capacity',
  'output',
  'military',
  'onGround',
  'altitudeM',
  'altitudeFt',
  'speedKts',
  'speedMps',
  'headingDeg',
  'heading',
  'icao24',
  'verticalRateMps',
  'feedType',
  'state',
  'tags',
  'codec',
  'bitrate',
  'source',
];

export function layerTitleForBrief(layerId) {
  return LAYER_TITLES[layerId] || String(layerId || 'Entity').replace(/-/g, ' ');
}

export function cleanBriefText(value) {
  if (value == null || typeof value === 'object') return '';
  const text = String(value).trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export function compactBriefProperties(props = {}) {
  const flat = { ...props };
  if (props.tags && typeof props.tags === 'object' && !Array.isArray(props.tags)) {
    Object.assign(flat, props.tags);
  }
  const result = {};
  for (const key of PREFERRED_PROPERTY_KEYS) {
    if (key === 'tags' && Array.isArray(flat.tags)) {
      const tags = flat.tags.map(cleanBriefText).filter(Boolean).slice(0, 4);
      if (tags.length) result.tags = tags;
      continue;
    }
    const value = cleanBriefText(flat[key]);
    if (value) result[key] = value;
  }
  for (const [key, value] of Object.entries(flat)) {
    if (Object.keys(result).length >= 16) break;
    if (key === 'tags' || result[key] !== undefined) continue;
    const text = cleanBriefText(value);
    if (text) result[key] = text;
  }
  return result;
}

export function summarizeRecordForBrief(record) {
  if (!record) return null;
  const properties = compactBriefProperties(record.properties || {});
  return {
    id: String(record.id || ''),
    name: cleanBriefText(record.label || record.properties?.name) || layerTitleForBrief(record.layerId),
    layerId: record.layerId || null,
    layerName: record.layerName || layerTitleForBrief(record.layerId),
    source: cleanBriefText(record.source) || null,
    latitude: Number.isFinite(record.latitude) ? record.latitude : null,
    longitude: Number.isFinite(record.longitude) ? record.longitude : null,
    properties,
  };
}

export function buildEntityBriefPayload(record) {
  const target = summarizeRecordForBrief(record);
  if (!target) return null;
  return {
    kind: 'contact',
    target,
    requestedAt: new Date().toISOString(),
  };
}

/** Rough bounding-box area in km² for marquee context. */
export { estimateBoundsAreaKm2 } from './intelAreaContext.js';

export function formatRegionTitle({ place, bounds } = {}) {
  if (place?.label) return place.label;
  if (bounds?.center) return formatCoordHeading(bounds.center.lat, bounds.center.lon);
  return 'Selected area';
}

function compactWeatherForBrief(weather) {
  if (!weather) return null;
  return {
    summary: weatherCodeLabel(weather.weatherCode),
    temperatureC: Number.isFinite(weather.temperatureC) ? weather.temperatureC : null,
    windKph: Number.isFinite(weather.windKph) ? weather.windKph : null,
    precipitationMm: Number.isFinite(weather.precipitationMm) ? weather.precipitationMm : null,
  };
}

function compactHeadlinesForBrief(articles) {
  return (articles || [])
    .slice(0, 4)
    .map((article) => cleanBriefText(typeof article === 'string' ? article : article?.title, 140))
    .filter(Boolean);
}

/** Normalize headline strings or { title } records for display and Gemini payloads. */
export function normalizeHeadlineTitles(headlines = []) {
  return compactHeadlinesForBrief(headlines);
}

function weatherSentence(weather) {
  const wx = compactWeatherForBrief(weather);
  if (!wx?.summary) return '';
  const temp = Number.isFinite(wx.temperatureC) ? ` around ${Math.round(wx.temperatureC)}°C` : '';
  return `Conditions read ${wx.summary.toLowerCase()}${temp}.`;
}

function naturalWeatherClause(weather) {
  const wx = compactWeatherForBrief(weather);
  if (!wx?.summary) return '';
  const temp = Number.isFinite(wx.temperatureC)
    ? `Temperature in the area is currently about ${Math.round(wx.temperatureC)}°C`
    : 'Conditions in the area';
  const summary = wx.summary.toLowerCase();
  if (temp.startsWith('Temperature')) return `${temp} under ${summary} skies.`;
  return `${temp} read ${summary}.`;
}

/** Known ICAO type codes → plain name + typical role (facts only, no mission guesses). */
const AIRCRAFT_TYPE_PROFILES = Object.freeze({
  K35R: { name: 'KC-135 Stratotanker', role: 'aerial refueling', operatorHint: 'U.S. military' },
  KC135: { name: 'KC-135 Stratotanker', role: 'aerial refueling', operatorHint: 'U.S. military' },
  C17: { name: 'C-17 Globemaster', role: 'strategic airlift', operatorHint: 'U.S. military' },
  C17M: { name: 'C-17 Globemaster', role: 'strategic airlift', operatorHint: 'U.S. military' },
  P8: { name: 'P-8 Poseidon', role: 'maritime patrol', operatorHint: 'U.S. Navy' },
  P8A: { name: 'P-8 Poseidon', role: 'maritime patrol', operatorHint: 'U.S. Navy' },
  NH90: { name: 'NH90 helicopter', role: 'naval utility transport' },
  EC35: { name: 'Eurocopter helicopter', role: 'utility transport' },
  B738: { name: 'Boeing 737-800', role: 'commercial airliner' },
  B77W: { name: 'Boeing 777', role: 'commercial airliner' },
  A320: { name: 'Airbus A320', role: 'commercial airliner' },
});

function aircraftTypeProfile(props = {}) {
  const code = cleanBriefText(props.typeCode || props.type).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code && AIRCRAFT_TYPE_PROFILES[code]) return AIRCRAFT_TYPE_PROFILES[code];
  const klass = cleanBriefText(props.aircraftClass || props.type);
  if (klass) return { name: klass, role: null, operatorHint: null };
  return null;
}

function aircraftActivityPhrase(props = {}) {
  if (props.onGround === true || props.onGround === 'true') return 'parked on the ground';
  const speedMps = Number(props.speedMps);
  const kts = Number.isFinite(speedMps) ? speedMps * 1.94384 : NaN;
  const altFt = Number(props.altitudeFt);
  const altM = Number(props.altitudeM);
  const atAlt = Number.isFinite(altFt) && altFt > 500
    ? `at FL${Math.round(altFt / 100)}`
    : Number.isFinite(altM) && altM > 150
      ? `at ${Math.round(altM)} m`
      : '';
  const hdg = formatHeading(props);
  const heading = hdg ? `heading ${hdg}` : '';
  if (Number.isFinite(kts) && kts >= 90) {
    return ['circulating the area', atAlt, heading].filter(Boolean).join(', ');
  }
  if (Number.isFinite(kts) && kts >= 25) {
    return ['moving through the box', atAlt, heading].filter(Boolean).join(', ');
  }
  if (atAlt || heading) return [atAlt, heading].filter(Boolean).join(', ');
  return 'holding in the area';
}

function formatOperatorLabel(props = {}) {
  const operator = cleanBriefText(props.operator || props.originCountry);
  if (!operator) return '';
  if (/USAF|United States Air Force/i.test(operator)) return 'U.S. Air Force';
  if (/US Navy|United States Navy/i.test(operator)) return 'U.S. Navy';
  if (/RAF|Royal Air Force/i.test(operator)) return 'Royal Air Force';
  return operator;
}

function describeAircraftInline(contact) {
  const props = contact?.properties || {};
  const name = cleanBriefText(props.callsign || props.registration || contact?.name) || 'unknown track';
  const profile = aircraftTypeProfile(props);
  const operator = formatOperatorLabel(props);
  const activity = aircraftActivityPhrase(props);

  const chunks = [name];
  if (profile?.name) {
    chunks.push(`a ${profile.name}`);
    if (operator) chunks.push(`flown by ${operator}`);
    else if (profile.operatorHint) chunks.push(`commonly ${profile.operatorHint}`);
    if (profile.role) chunks.push(`used for ${profile.role}`);
  } else if (operator) {
    chunks.push(`operated by ${operator}`);
  }

  if (activity) chunks.push(`currently ${activity}`);

  if (profile?.role && contact?.layerId === 'military') {
    return `${chunks.join(', ')} — activity like this is often tied to ${profile.role} in busy corridors`;
  }
  return chunks.join(', ');
}

function describeWhereClause({ place, bounds, landmarks = [] }) {
  const closeLandmarks = (landmarks || []).filter((entry) => entry?.name && (entry.inSelection || entry.distanceKm <= 30));
  if (place?.label) {
    const region = place.region && !place.label.includes(place.region) ? `, ${place.region}` : '';
    const country = place.country && !`${place.label}${region}`.includes(place.country) ? `, ${place.country}` : '';
    return `around ${place.label}${region}${country}`;
  }
  if (closeLandmarks.length) {
    const anchor = closeLandmarks[0].name;
    const coords = bounds?.center ? ` (${formatCoordHeading(bounds.center.lat, bounds.center.lon)})` : '';
    return `around ${anchor}${coords}`;
  }
  if (bounds?.center) {
    return `around ${formatCoordHeading(bounds.center.lat, bounds.center.lon)}`;
  }
  return 'in this map sector';
}

function joinNaturalList(items = []) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

/** One flowing analyst brief — the voice the operator asked for. */
export function buildNaturalIntelBrief({
  place = null,
  weather = null,
  headlineTitles = [],
  headlines = [],
  contacts = [],
  bounds = null,
  landmarks = [],
  enabledLayers = [],
  geoReliable = true,
} = {}) {
  const sentences = [];
  const where = describeWhereClause({ place, bounds, landmarks });
  sentences.push(`You're looking ${where}.`);

  const military = contacts.filter((c) => c.layerId === 'military' || c.layerId === 'flights');
  const cctv = contacts.filter((c) => c.layerId === 'cctv');
  const radio = contacts.filter((c) => c.layerId === 'radio');
  const vessels = contacts.filter((c) => c.layerId === 'ais-live-vessels');

  if (military.length) {
    const n = military.length;
    const profiles = military.slice(0, 4).map(describeAircraftInline);
    const lead = n === 1
      ? 'I can see one military aircraft in the area you boxed'
      : `I can see ${n} military aircraft in the area you boxed`;
    sentences.push(`${lead}: ${joinNaturalList(profiles)}.`);
    if (military.length > 4) {
      sentences.push(`${military.length - 4} more military tracks are in frame but not expanded here.`);
    }
  } else {
    sentences.push('No military or civil aircraft appear inside the box you drew right now.');
  }

  if (vessels.length) {
    const names = vessels.slice(0, 3).map((v) => cleanBriefText(v.name) || 'vessel');
    sentences.push(`AIS shows ${vessels.length === 1 ? 'one vessel' : `${vessels.length} vessels`} here — ${joinNaturalList(names)}.`);
  }

  const wxClause = naturalWeatherClause(weather);
  if (wxClause) sentences.push(wxClause);

  const cctvOn = (enabledLayers || []).some((layer) => layer.id === 'cctv');
  if (cctv.length) {
    const feeds = cctv.slice(0, 4).map((cam) => {
      const props = cam.properties || {};
      const label = cleanBriefText(props.name || cam.name) || 'camera';
      const city = cleanBriefText(props.city);
      return city ? `${label} in ${city}` : label;
    });
    sentences.push(`Active CCTV you can access here includes ${joinNaturalList(feeds)}.`);
  } else if (cctvOn) {
    sentences.push('No public CCTV feeds fall inside this box at the moment.');
  }

  if (radio.length) {
    const stations = radio.slice(0, 3).map((r) => cleanBriefText(r.name) || 'station');
    sentences.push(`Radio monitoring picks up ${joinNaturalList(stations)} in this selection.`);
  }

  const titles = headlineTitles.length ? headlineTitles : normalizeHeadlineTitles(headlines);
  if (titles.length) {
    sentences.push(`Local headlines mention ${titles.slice(0, 2).map((t) => `“${t}”`).join(' and ')}.`);
  }

  if (!geoReliable && military.length) {
    sentences.push('Tracks are matched to what appeared inside your drawn box, not the wide geo footprint behind it.');
  }

  return sentences.join(' ');
}

function formatContactDisplay(contact) {
  const props = contact?.properties || {};
  const name = cleanBriefText(contact?.name) || cleanBriefText(props.callsign) || cleanBriefText(props.name) || 'Unknown';
  const meta = [];
  const layerId = contact?.layerId || '';

  if (layerId === 'cctv') {
    const city = cleanBriefText(props.city);
    const provider = cleanBriefText(props.provider);
    const heading = Number(props.headingDeg);
    if (city) meta.push(city);
    if (provider) meta.push(provider);
    if (Number.isFinite(heading)) meta.push(`hdg ${Math.round(heading)}°`);
    return { name, meta: meta.join(' · '), layerName: cleanBriefText(contact?.layerName) };
  }

  if (layerId === 'radio') {
    const country = cleanBriefText(props.country || props.state);
    const tags = Array.isArray(props.tags) ? props.tags.slice(0, 2).map(cleanBriefText).filter(Boolean) : [];
    if (country) meta.push(country);
    if (tags.length) meta.push(tags.join(', '));
    const bitrate = Number(props.bitrate);
    if (Number.isFinite(bitrate) && bitrate > 0) meta.push(`${bitrate} kbps`);
    return { name, meta: meta.join(' · '), layerName: cleanBriefText(contact?.layerName) };
  }

  const type = cleanBriefText(props.typeCode || props.type || props.aircraftClass || props.shipType);
  if (type) meta.push(type);
  const altFt = Number(props.altitudeFt);
  const altM = Number(props.altitudeM);
  if (Number.isFinite(altFt) && altFt > 50) {
    meta.push(`FL${Math.round(altFt / 100)}`);
  } else if (Number.isFinite(altM) && altM > 15) {
    meta.push(`FL${Math.round((altM * 3.28084) / 100)}`);
  } else if (Number.isFinite(altFt) || Number.isFinite(altM)) {
    meta.push('surface');
  }
  const operator = cleanBriefText(props.operator || props.originCountry);
  if (operator) meta.push(operator);
  const routeOrigin = cleanBriefText(props.routeOrigin || props.origin);
  const routeDestination = cleanBriefText(props.routeDestination || props.destination);
  if (routeOrigin && routeDestination) meta.push(`${routeOrigin} → ${routeDestination}`);
  return {
    name,
    meta: meta.join(' · '),
    layerName: cleanBriefText(contact?.layerName),
  };
}

function formatCoordHeading(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const latH = lat >= 0 ? `${Math.abs(lat).toFixed(2)}°N` : `${Math.abs(lat).toFixed(2)}°S`;
  const lonH = lon >= 0 ? `${Math.abs(lon).toFixed(2)}°E` : `${Math.abs(lon).toFixed(2)}°W`;
  return `${latH}, ${lonH}`;
}

function formatAltitude(props = {}) {
  const altFt = Number(props.altitudeFt);
  const altM = Number(props.altitudeM);
  if (props.onGround === true || props.onGround === 'true') return 'On ground';
  if (Number.isFinite(altFt) && altFt > 50) {
    return `${Math.round(altFt).toLocaleString()} ft · FL${Math.round(altFt / 100)}`;
  }
  if (Number.isFinite(altM) && altM > 15) {
    const ft = Math.round(altM * 3.28084);
    return `${Math.round(altM).toLocaleString()} m · FL${Math.round(ft / 100)}`;
  }
  if (Number.isFinite(altFt) || Number.isFinite(altM)) return 'Surface/low altitude';
  return '';
}

function formatSpeed(props = {}) {
  const speedMps = Number(props.speedMps ?? props.speedKts);
  if (Number.isFinite(props.speedKts)) return `${Math.round(props.speedKts)} kts`;
  if (Number.isFinite(speedMps)) return `${Math.round(speedMps * 1.94384)} kts`;
  return '';
}

function formatHeading(props = {}) {
  const heading = Number(props.heading ?? props.headingDeg);
  if (!Number.isFinite(heading)) return '';
  return `${Math.round(heading)}°`;
}

function formatContactDetailCard(contact) {
  const props = contact?.properties || {};
  const layerId = contact?.layerId || '';
  const lat = Number(contact?.latitude ?? props.lat);
  const lon = Number(contact?.longitude ?? props.lon);
  const callsign = cleanBriefText(props.callsign || contact?.name);
  const registration = cleanBriefText(props.registration);
  const icao24 = cleanBriefText(props.icao24);
  const title = callsign || registration || icao24 || cleanBriefText(contact?.name) || 'Unknown contact';
  const lines = [];

  if (layerId === 'military') {
    lines.push('Military ADS-B track');
  } else if (layerId === 'flights') {
    lines.push(props.military === true || props.military === 'true' ? 'Military-coded commercial feed track' : 'Commercial ADS-B track');
  } else if (layerId === 'cctv') {
    lines.push('Public CCTV camera');
  } else if (layerId === 'radio') {
    lines.push('Radio station');
  } else if (layerId === 'ais-live-vessels') {
    lines.push('AIS vessel');
  }

  const typeBits = [
    cleanBriefText(props.typeCode || props.type),
    cleanBriefText(props.aircraftClass),
    cleanBriefText(props.shipType),
  ].filter(Boolean);
  const uniqueType = [...new Set(typeBits)];
  if (uniqueType.length) lines.push(`Type: ${uniqueType.join(' · ')}`);

  if (registration && registration !== title) lines.push(`Tail / reg: ${registration}`);
  if (icao24) lines.push(`ICAO: ${icao24}`);

  const operator = cleanBriefText(props.operator || props.originCountry);
  if (operator) lines.push(`Operator: ${operator}`);

  const city = cleanBriefText(props.city);
  const provider = cleanBriefText(props.provider);
  if (city || provider) lines.push([city, provider].filter(Boolean).join(' · '));

  const motion = [];
  const alt = formatAltitude(props);
  if (alt) motion.push(alt);
  const speed = formatSpeed(props);
  if (speed) motion.push(`${speed}`);
  const hdg = formatHeading(props);
  if (hdg) motion.push(`heading ${hdg}`);
  const vRate = Number(props.verticalRateMps);
  if (Number.isFinite(vRate) && Math.abs(vRate) > 0.5) {
    motion.push(`${vRate > 0 ? 'climbing' : 'descending'} ${Math.abs(Math.round(vRate * 196.85))} ft/min`);
  }
  if (motion.length) lines.push(motion.join(' · '));

  const routeOrigin = cleanBriefText(props.routeOrigin || props.origin);
  const routeDestination = cleanBriefText(props.routeDestination || props.destination);
  if (routeOrigin && routeDestination) lines.push(`Route: ${routeOrigin} → ${routeDestination}`);
  else if (routeDestination) lines.push(`Destination: ${routeDestination}`);

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    lines.push(`Position: ${formatCoordHeading(lat, lon)}`);
  }

  if (layerId === 'radio' && Array.isArray(props.tags) && props.tags.length) {
    lines.push(`Tags: ${props.tags.slice(0, 3).join(', ')}`);
  }

  const feedType = cleanBriefText(props.feedType);
  if (feedType) lines.push(`Feed: ${feedType}`);

  return { title, lines: lines.filter(Boolean), layerId };
}

function buildOpeningParagraph({
  place,
  bounds,
  areaKm2,
  contacts,
  geoReliable = true,
}) {
  let opener;
  if (place?.label) {
    opener = `This is ${place.label}${place.country && !place.label.includes(place.country) ? `, ${place.country}` : ''}`;
  } else if (bounds?.center) {
    opener = `This is the map area at ${formatCoordHeading(bounds.center.lat, bounds.center.lon)}`;
  } else {
    opener = 'This is your selected map area';
  }

  if (!geoReliable) {
    opener += '. Only tracks that appeared inside the box you drew are listed';
  } else {
    const footprint = bounds ? formatBoundsSummary(bounds, areaKm2).replace(/\.$/, '') : '';
    if (footprint) opener += `. ${footprint}`;
  }

  if (!contacts.length) {
    return `${opener}. Nothing live is in the box right now.`;
  }

  const label = assetCountLabel(summarizeAssetCounts(contacts));
  return `${opener}. ${label || `${contacts.length} contacts`} in the box.`;
}

export function formatContactProse(contact) {
  const props = contact?.properties || {};
  const layerId = contact?.layerId || '';
  const name = cleanBriefText(props.callsign || props.registration || contact?.name) || 'Unknown';
  const lat = Number(contact?.latitude ?? props.lat);
  const lon = Number(contact?.longitude ?? props.lon);

  if (layerId === 'military' || layerId === 'flights') {
    const type = cleanBriefText(props.type || props.aircraftClass || props.typeCode);
    const operator = cleanBriefText(props.operator);
    const prefix = layerId === 'military' ? 'Military track' : 'Aircraft';
    let head = `${prefix} ${name}`;
    if (type) head += ` (${type})`;

    const clauses = [];
    if (operator) clauses.push(`operated by ${operator}`);
    if (props.onGround === true || props.onGround === 'true') {
      clauses.push('on the ground');
    } else {
      const altFt = Number(props.altitudeFt);
      const altM = Number(props.altitudeM);
      if (Number.isFinite(altFt) && altFt > 50) clauses.push(`at FL${Math.round(altFt / 100)}`);
      else if (Number.isFinite(altM) && altM > 15) clauses.push(`at ${Math.round(altM)} m`);
    }
    const speed = formatSpeed(props);
    if (speed) clauses.push(speed);
    const hdg = formatHeading(props);
    if (hdg) clauses.push(`heading ${hdg}`);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      clauses.push(`over ${formatCoordHeading(lat, lon)}`);
    }
    if (clauses.length) return `${head} — ${clauses.join(', ')}.`;
    return `${head}.`;
  }

  if (layerId === 'cctv') {
    const city = cleanBriefText(props.city);
    const provider = cleanBriefText(props.provider);
    const where = [city, provider].filter(Boolean).join(', ');
    const loc = Number.isFinite(lat) && Number.isFinite(lon) ? ` at ${formatCoordHeading(lat, lon)}` : '';
    return `Camera ${name}${where ? ` (${where})` : ''}${loc}.`;
  }

  if (layerId === 'radio') {
    const country = cleanBriefText(props.country || props.state);
    return `Radio station ${name}${country ? ` in ${country}` : ''}.`;
  }

  if (layerId === 'ais-live-vessels') {
    const shipType = cleanBriefText(props.shipType);
    const dest = cleanBriefText(props.destination || props.routeDestination);
    let sentence = `Vessel ${name}`;
    if (shipType) sentence += ` (${shipType})`;
    if (dest) sentence += ` bound for ${dest}`;
    if (Number.isFinite(lat) && Number.isFinite(lon)) sentence += ` at ${formatCoordHeading(lat, lon)}`;
    return `${sentence}.`;
  }

  return `${name}.`;
}

function buildContactParagraphs(contacts = [], limit = 8) {
  return contacts.slice(0, limit).map(formatContactProse).filter(Boolean);
}

function buildAssetGroupRows(contacts = [], limitPerGroup = 6) {
  return groupContactsForBrief(contacts).map((group) => ({
    label: group.label,
    layerId: group.layerId,
    items: group.items,
    rows: group.items.slice(0, limitPerGroup).map(formatContactDisplay).filter((row) => row.name),
    more: Math.max(0, group.items.length - limitPerGroup),
  })).filter((group) => group.items.length);
}

function buildContactCards(contacts = [], limit = 8) {
  return contacts.slice(0, limit).map(formatContactDetailCard).filter((card) => card.title);
}

function formatPlaceHeadline(place, bounds) {
  if (place?.label) {
    const parts = [place.label];
    if (place.region && !place.label.includes(place.region)) parts.push(place.region);
    if (place.country && !parts.join(', ').includes(place.country)) parts.push(place.country);
    return parts.join(', ');
  }
  if (bounds?.center) {
    return `${bounds.center.lat.toFixed(4)}°, ${bounds.center.lon.toFixed(4)}°`;
  }
  return 'Selected sector';
}

const MONITORING_LAYER_IDS = new Set([
  'cctv', 'flights', 'military', 'ais-live-vessels', 'radio', 'satellites', 'earthquakes', 'local-firms',
]);

function formatSelectionSummary(contacts = [], enabledLayers = []) {
  const label = assetCountLabel(summarizeAssetCounts(contacts));
  if (label) return `${label} inside this box.`;

  const active = (enabledLayers || [])
    .filter((layer) => layer?.enabled !== false && MONITORING_LAYER_IDS.has(layer.id))
    .map((layer) => layer.name || layer.id);
  if (active.length) {
    return `No live contacts in this box. Layers on: ${active.join(', ')}.`;
  }
  return 'No live contacts in this box. Turn on CCTV, Flights, Radio, or AIS to detect assets here.';
}

function formatLandmarkLine(landmarks = []) {
  const entries = (landmarks || []).filter((entry) => entry?.name).slice(0, 3);
  if (!entries.length) return '';
  return entries.map((entry) => {
    const dist = Number.isFinite(entry.distanceKm) ? ` (${entry.distanceKm} km)` : '';
    return `${entry.name}${dist}`;
  }).join(' · ');
}

export const VISION_PENDING_NARRATIVE = 'Reading what you\'re looking at…';

/** Natural-language brief parts for the intel card. */
export function buildPlaceNarrativeParts({
  place = null,
  weather = null,
  headlineTitles = [],
  headlines = [],
  contacts = [],
  bounds = null,
  areaKm2 = null,
  landmarks = [],
  enabledLayers = [],
  geoReliable = true,
  viewportCapture = null,
  visionPending = false,
} = {}) {
  if (visionPending) {
    return {
      headline: formatPlaceHeadline(place, bounds),
      narrative: VISION_PENDING_NARRATIVE,
      openingParagraph: VISION_PENDING_NARRATIVE,
      whereParagraph: VISION_PENDING_NARRATIVE,
      whatParagraph: '',
      selectionSummary: formatSelectionSummary(contacts, enabledLayers),
      lede: VISION_PENDING_NARRATIVE,
      areaLine: bounds ? formatBoundsSummary(bounds, areaKm2) : '',
      landmarkLine: formatLandmarkLine((landmarks || []).filter((entry) => entry?.name)),
      headlineLine: '',
      weatherLine: '',
      footnoteLine: '',
      assetGroups: [],
      contactParagraphs: [],
      contactCards: [],
      moreContacts: 0,
      landmarkLines: (landmarks || []).filter((entry) => entry?.name),
      trackLines: [],
      trackMore: 0,
      visionPending: true,
    };
  }

  const titles = headlineTitles.length ? headlineTitles : normalizeHeadlineTitles(headlines);
  const assetGroups = buildAssetGroupRows(contacts);
  const trackLines = contacts.slice(0, 8).map(formatContactDisplay).filter((row) => row.name);
  const catalogLandmarks = (landmarks || []).filter((entry) => entry?.name);

  const headline = formatPlaceHeadline(place, bounds);
  const narrative = buildNaturalIntelBrief({
    place,
    weather,
    headlineTitles: titles,
    headlines,
    contacts,
    bounds,
    landmarks: catalogLandmarks,
    enabledLayers,
    geoReliable,
  });
  const openingParagraph = narrative;
  const contactParagraphs = [];
  const selectionSummary = formatSelectionSummary(contacts, enabledLayers);
  const areaLine = bounds ? formatBoundsSummary(bounds, areaKm2) : '';
  const landmarkLine = formatLandmarkLine(catalogLandmarks);

  let headlineLine = '';
  if (titles.length) {
    const quoted = titles.slice(0, 2).map((title) => `“${title}”`);
    headlineLine = quoted.length === 1
      ? `In the news locally: ${quoted[0]}.`
      : `In the news locally: ${quoted[0]} and ${quoted[1]}.`;
  }

  const footnoteParts = [];
  const wxLine = weatherSentence(weather);

  const moreContacts = 0;

  return {
    headline,
    narrative,
    openingParagraph,
    whereParagraph: narrative,
    whatParagraph: '',
    selectionSummary,
    lede: narrative,
    areaLine,
    landmarkLine,
    headlineLine,
    weatherLine: wxLine,
    footnoteLine: '',
    assetGroups,
    contactParagraphs,
    contactCards: contactParagraphs.map((text, index) => ({
      title: trackLines[index]?.name || `Contact ${index + 1}`,
      lines: [text],
    })),
    moreContacts,
    landmarkLines: catalogLandmarks,
    trackLines,
    trackMore: Math.max(0, contacts.length - trackLines.length),
  };
}

/** Cockpit-native prose for the intel panel — no raw payload dump. */
export function buildPlaceNarrative(context = {}) {
  return buildPlaceNarrativeParts(context).narrative;
}

export function buildRegionBriefPayload({
  bounds,
  contacts = [],
  enabledLayers = [],
  place = null,
  weather = null,
  headlines = [],
  areaKm2 = null,
  landmarks = [],
  assetSummary = null,
  viewportCapture = null,
  geoReliable = true,
}) {
  if (!bounds) return null;
  const approxKm2 = areaKm2 ?? estimateBoundsAreaKm2(bounds);
  const summary = assetSummary ?? summarizeAssetCounts(contacts);
  return {
    kind: 'marquee',
    focus: 'viewport',
    viewportCapture: viewportCapture
      ? {
        mimeType: viewportCapture.mimeType || 'image/jpeg',
        width: viewportCapture.width,
        height: viewportCapture.height,
        dataBase64: viewportCapture.dataBase64,
      }
      : null,
    geoReliable: Boolean(geoReliable),
    selection: {
      bounds: {
        south: bounds.south,
        north: bounds.north,
        west: bounds.west,
        east: bounds.east,
        center: bounds.center,
      },
      boundsSummary: formatBoundsSummary(bounds, approxKm2),
      approxAreaKm2: approxKm2,
      contactCount: contacts.length,
      assetSummary: summary,
    },
    place: place
      ? {
        label: place.label,
        locality: place.locality,
        region: place.region,
        country: place.country,
        countryCode: place.countryCode,
      }
      : null,
    landmarks: (landmarks || []).map((entry) => ({
      name: entry.name,
      city: entry.city,
      distanceKm: entry.distanceKm,
      inSelection: Boolean(entry.inSelection),
    })),
    weather: compactWeatherForBrief(weather),
    headlines: normalizeHeadlineTitles(headlines),
    contacts,
    enabledLayers,
    requestedAt: new Date().toISOString(),
  };
}

export function buildLocalRegionBrief(context, { unconfigured = false } = {}) {
  if (!context?.bounds) return 'Hold Alt and drag to identify an area.';
  const narrative = buildPlaceNarrative(context);
  if (unconfigured) {
    return `${narrative}\n\nAdd GEMINI_API_KEY in Provider Settings for AI streaming.`;
  }
  return narrative;
}

export function metaChipsFromRegion({ weather = null, contacts = [], bounds = null, areaKm2 = null } = {}) {
  const chips = [];
  const assetLabel = assetCountLabel(summarizeAssetCounts(contacts));
  if (assetLabel) chips.push(assetLabel);
  else if (bounds) {
    const approx = areaKm2 ?? estimateBoundsAreaKm2(bounds);
    if (Number.isFinite(approx) && approx > 0) {
      chips.push(approx < 1 ? `~${approx.toFixed(2)} km²` : `~${Math.round(approx)} km²`);
    }
  }
  const wx = compactWeatherForBrief(weather);
  if (wx?.summary && chips.length < 2) {
    const temp = Number.isFinite(wx.temperatureC) ? `${Math.round(wx.temperatureC)}°C` : null;
    chips.push([wx.summary, temp].filter(Boolean).join(' · '));
  }
  return chips.slice(0, 2);
}

export function buildLocalEntityBrief(record) {
  const target = summarizeRecordForBrief(record);
  if (!target) return 'Select a contact on the globe for an intelligence brief.';
  const lines = [
    `${target.layerName}: ${target.name}`,
  ];
  if (target.source) lines.push(`Source: ${target.source}`);
  if (Number.isFinite(target.latitude) && Number.isFinite(target.longitude)) {
    lines.push(`Position: ${target.latitude.toFixed(4)}°, ${target.longitude.toFixed(4)}°`);
  }
  const props = target.properties || {};
  const detailParts = [];
  for (const key of PREFERRED_PROPERTY_KEYS) {
    if (props[key]) detailParts.push(`${key}: ${props[key]}`);
  }
  if (detailParts.length) lines.push(detailParts.join(' · '));
  lines.push('Add GEMINI_API_KEY for a streamed AI explanation.');
  return lines.join('\n\n');
}

export function metaChipsFromRecord(record) {
  const target = summarizeRecordForBrief(record);
  if (!target) return [];
  const props = target.properties || {};
  const chips = [target.layerName];
  for (const key of ['type', 'typeCode', 'callsign', 'registration', 'operator', 'shipType', 'provider', 'city']) {
    const value = cleanBriefText(props[key]);
    if (value && !chips.includes(value)) chips.push(value);
  }
  return chips.slice(0, 6);
}
