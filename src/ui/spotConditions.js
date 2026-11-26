import { codeWord } from '../data/entityContext.js';
import { greatCircleKm } from '../geoDistance.js';
import { formatNumber, msg, t, tn } from '../i18n/index.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createFirmsSource } from '../layers/firms/source.js';

// Weather is kept per spot. Hazard feeds are global snapshots shared by
// all spots for a few minutes.

const BRIEF_TTL_MS = 10 * 60_000;
const FEED_TTL_MS = 5 * 60_000;

const briefs = new Map();
/**
 * Read weather for a spot. A failed read is forgotten so the next call retries.
 * @param {number} lat
 * @param {number} lon
 * @param {(lat: number, lon: number, options: {signal: AbortSignal}) => Promise<object>} load
 * @param {{force?: boolean}} [options] `force` reads again whatever is kept.
 */
export function regionalBrief(lat, lon, load, { force = false } = {}) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const kept = briefs.get(key);
  if (!force && kept && Date.now() - kept.at < BRIEF_TTL_MS)
    return kept.promise;
  const forget = () => {
    if (briefs.get(key)?.promise === promise) briefs.delete(key);
    return null;
  };
  // The kept read is shared by every card at this spot, so no card aborts it.
  const promise = Promise.resolve()
    .then(() => load(lat, lon, { signal: new AbortController().signal }))
    .then((brief) => brief ?? forget(), forget);
  briefs.set(key, { at: Date.now(), promise });
  if (briefs.size > 40) briefs.delete(briefs.keys().next().value);
  return promise;
}

const feeds = new Map();
function snapshot(name, load, force) {
  const kept = feeds.get(name);
  if (!force && kept && Date.now() - kept.at < FEED_TTL_MS) return kept.promise;
  const promise = load().catch(() => null);
  feeds.set(name, { at: Date.now(), promise });
  return promise;
}
const quakes = (force) =>
  snapshot('quakes', () => createUsgsEarthquakeSource().getSnapshot(), force);
const storms = (force) =>
  snapshot('storms', () => createCycloneSource().getSnapshot(), force);
const perimeters = (force) =>
  snapshot(
    'perimeters',
    () => createWfigsPerimeterSource().getSnapshot(),
    force,
  );
const fires = (force) =>
  snapshot('fires', () => createFirmsSource().getSnapshot(), force);

// English compass points, which the UI shows through t().
const COMPASS = [
  msg('N'),
  msg('NE'),
  msg('E'),
  msg('SE'),
  msg('S'),
  msg('SW'),
  msg('W'),
  msg('NW'),
];
/** The compass point from one spot to another, like "NE". */
export function compassPoint(from, to) {
  const rad = Math.PI / 180;
  const y = Math.sin((to.lon - from.lon) * rad) * Math.cos(to.lat * rad);
  const x =
    Math.cos(from.lat * rad) * Math.sin(to.lat * rad) -
    Math.sin(from.lat * rad) *
      Math.cos(to.lat * rad) *
      Math.cos((to.lon - from.lon) * rad);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return compassName(deg);
}

/** The compass point for a bearing in degrees. */
export function compassName(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** A storm as "Hurricane Melissa": its class in words when the code has them. */
function stormTitle(storm) {
  const word = codeWord('classification', storm.classification);
  if (!word)
    return [storm.classification, storm.name].filter(Boolean).join(' ');
  return storm.name
    ? t('{kind} {name}', { kind: t(word), name: storm.name })
    : t(word);
}

/**
 * Hazards within a radius of a spot, nearest first within each kind:
 * `[{kind, icon, title, detail, distanceKm, at}]`. Every kind uses the same
 * radius, the one Context's radius control sets. Satellite fire hits need a
 * FIRMS key the browser cannot see, so they are read only with `fires`: while
 * the FIRMS layer is on, which has found the key works.
 */
export async function hazardsNear(
  lat,
  lon,
  radiusKm = 250,
  { fires: withFires = false, force = false } = {},
) {
  const here = { lat, lon };
  const [quakeRows, stormSnap, perimeterSnap, fireSnap] = await Promise.all([
    quakes(force),
    storms(force),
    perimeters(force),
    withFires ? fires(force) : null,
  ]);
  const found = [];
  const add = (row) => {
    row.distanceKm = greatCircleKm(here, row.at);
    row.direction = compassPoint(here, row.at);
    found.push(row);
  };

  for (const quake of Array.isArray(quakeRows) ? quakeRows : []) {
    const at = { lat: quake.lat, lon: quake.lon };
    if (!(greatCircleKm(here, at) <= radiusKm)) continue;
    add({
      kind: 'quake',
      icon: 'earthquake',
      title: Number.isFinite(Number.parseFloat(quake.mag))
        ? t('M{mag} earthquake', { mag: Number(quake.mag).toFixed(1) })
        : t('Earthquake'),
      detail: quake.place || '',
      time: quake.time,
      at,
    });
  }
  for (const storm of stormSnap?.storms || []) {
    const at = {
      lat: storm.position?.latitude,
      lon: storm.position?.longitude,
    };
    if (!(greatCircleKm(here, at) <= radiusKm)) continue;
    add({
      kind: 'storm',
      icon: 'cyclone',
      title: stormTitle(storm),
      detail: storm.windKt ? t('{n} kt winds', { n: storm.windKt }) : '',
      time: Date.parse(storm.positionAt) || null,
      at,
    });
  }
  for (const fire of perimeterSnap?.fires || []) {
    // The point the fire's card stands on, close enough for "how far".
    const at = fire.anchor;
    if (!at || !(greatCircleKm(here, at) <= radiusKm)) continue;
    const acres = Number(fire.acres);
    add({
      kind: 'wildfire',
      icon: 'local_fire_department',
      title: fire.name || t('Wildfire'),
      detail: [
        Number.isFinite(acres)
          ? t('{n} acres', { n: formatNumber(Math.round(acres)) })
          : '',
        Number.isFinite(fire.containedPct)
          ? t('{n}% contained', { n: fire.containedPct })
          : '',
        fire.category === 'RX' ? t('prescribed burn') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      time: fire.updatedTime || fire.discoveredTime || null,
      at,
    });
  }
  // Satellite fire hits are many small points: count the close ones.
  const hits = (Array.isArray(fireSnap?.fires) ? fireSnap.fires : [])
    .map((fire) => ({
      lat: Number(fire.lat ?? fire.latitude),
      lon: Number(fire.lon ?? fire.longitude),
    }))
    .filter((at) => greatCircleKm(here, at) <= radiusKm);
  if (hits.length) {
    const nearest = hits.reduce((a, b) =>
      greatCircleKm(here, a) <= greatCircleKm(here, b) ? a : b,
    );
    add({
      kind: 'hotspots',
      icon: 'local_fire_department',
      title: tn(
        hits.length,
        '{count} satellite fire hit',
        '{count} satellite fire hits',
      ),
      detail: t('last day'),
      time: null,
      at: nearest,
    });
  }
  const order = { storm: 0, wildfire: 1, hotspots: 2, quake: 3 };
  return found.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.distanceKm - b.distanceKm,
  );
}

/** Title-case copy for a WMO weather code, and the icon that goes with it. */
export function weatherLook(code) {
  const value = code == null || code === '' ? NaN : Number(code);
  if (!Number.isFinite(value))
    return { label: msg('Conditions unknown'), icon: 'partly_cloudy_day' };
  if (value === 0) return { label: msg('Clear'), icon: 'sunny' };
  if (value <= 2)
    return { label: msg('Partly cloudy'), icon: 'partly_cloudy_day' };
  if (value === 3) return { label: msg('Overcast'), icon: 'cloud' };
  if (value === 45 || value === 48) return { label: msg('Fog'), icon: 'foggy' };
  if (value >= 51 && value <= 57)
    return { label: msg('Drizzle'), icon: 'rainy' };
  if (value >= 61 && value <= 67) return { label: msg('Rain'), icon: 'rainy' };
  if (value >= 71 && value <= 77)
    return { label: msg('Snow'), icon: 'weather_snowy' };
  if (value >= 80 && value <= 82)
    return { label: msg('Rain showers'), icon: 'rainy' };
  if (value >= 85 && value <= 86)
    return { label: msg('Snow showers'), icon: 'weather_snowy' };
  if (value >= 95) return { label: msg('Thunderstorm'), icon: 'thunderstorm' };
  return { label: msg('Mixed conditions'), icon: 'partly_cloudy_day' };
}

export function weatherFacts(now) {
  if (!now) return [];
  const facts = [];
  if (Number.isFinite(now.windKph)) {
    const speed = t('{n} km/h', { n: formatNumber(Math.round(now.windKph)) });
    facts.push({
      label: t('Wind'),
      value: Number.isFinite(now.windDirectionDeg)
        ? t('{speed} {direction}', {
            speed,
            direction: t(compassName(now.windDirectionDeg)),
          })
        : speed,
    });
  }
  if (Number.isFinite(now.cloudCoverPct))
    facts.push({
      label: t('Cloud'),
      value: t('{n}%', { n: formatNumber(Math.round(now.cloudCoverPct)) }),
    });
  if (Number.isFinite(now.visibilityM))
    facts.push({
      label: t('Visibility'),
      value: t('{n} km', {
        n: formatNumber(
          now.visibilityM >= 10_000
            ? Math.round(now.visibilityM / 1000)
            : Number((now.visibilityM / 1000).toFixed(1)),
        ),
      }),
    });
  if (Number.isFinite(now.precipitationMm))
    facts.push({
      label: t('Precipitation'),
      value: t('{n} mm', {
        n: formatNumber(now.precipitationMm, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      }),
    });
  return facts;
}
