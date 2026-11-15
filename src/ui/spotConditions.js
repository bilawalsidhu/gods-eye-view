import { codeWord, distanceKm } from '../data/entityContext.js';
import { msg, t, tn } from '../i18n/index.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createFirmsSource } from '../layers/firms/source.js';

// What is going on around one spot on the map: the weather there now and the
// local headlines (the app's regional brief, the same one Cockpit shows), and
// the natural hazards near it from the feeds the hazard layers read
// (earthquakes, tropical storms, wildfire perimeters, satellite fire hits).
// The feeds are global snapshots, so each is fetched once and kept for a few
// minutes whichever spot asks; the brief is kept per spot.

const BRIEF_TTL_MS = 10 * 60_000;
const FEED_TTL_MS = 5 * 60_000;

const briefs = new Map();
/** The regional brief for a spot: `{weather, articles, place, newsSource}`. */
export function regionalBrief(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const kept = briefs.get(key);
  if (kept && Date.now() - kept.at < BRIEF_TTL_MS) return kept.promise;
  const query = `latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`;
  const promise = fetch(`/api/regional-brief?${query}`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  briefs.set(key, { at: Date.now(), promise });
  if (briefs.size > 40) briefs.delete(briefs.keys().next().value);
  return promise;
}

const feeds = new Map();
function snapshot(name, load) {
  const kept = feeds.get(name);
  if (kept && Date.now() - kept.at < FEED_TTL_MS) return kept.promise;
  const promise = load().catch(() => null);
  feeds.set(name, { at: Date.now(), promise });
  return promise;
}
const quakes = () =>
  snapshot('quakes', () => createUsgsEarthquakeSource().getSnapshot());
const storms = () =>
  snapshot('storms', () => createCycloneSource().getSnapshot());
const perimeters = () =>
  snapshot('perimeters', () => createWfigsPerimeterSource().getSnapshot());
const fires = () => snapshot('fires', () => createFirmsSource().getSnapshot());

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

// The middle of a perimeter's first ring, close enough for "how far".
function perimeterMiddle(row) {
  const ring = row?.polygons?.[0]?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
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
 * radius, the one Context's radius control sets.
 */
export async function hazardsNear(lat, lon, radiusKm = 250) {
  const here = { lat, lon };
  const [quakeRows, stormSnap, perimeterRows, fireSnap] = await Promise.all([
    quakes(),
    storms(),
    perimeters(),
    fires(),
  ]);
  const found = [];
  const add = (row) => {
    row.distanceKm = distanceKm(here, row.at);
    row.direction = compassPoint(here, row.at);
    found.push(row);
  };

  for (const quake of Array.isArray(quakeRows) ? quakeRows : []) {
    const at = { lat: quake.lat, lon: quake.lon };
    if (!(distanceKm(here, at) <= radiusKm)) continue;
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
    if (!(distanceKm(here, at) <= radiusKm)) continue;
    add({
      kind: 'storm',
      icon: 'cyclone',
      title: stormTitle(storm),
      detail: storm.windKt ? t('{n} kt winds', { n: storm.windKt }) : '',
      time: Date.parse(storm.positionAt) || null,
      at,
    });
  }
  for (const fire of Array.isArray(perimeterRows) ? perimeterRows : []) {
    const at = perimeterMiddle(fire);
    if (!at || !(distanceKm(here, at) <= radiusKm)) continue;
    const acres = Number(fire.acres);
    add({
      kind: 'wildfire',
      icon: 'local_fire_department',
      title: fire.name || t('Wildfire'),
      detail: [
        Number.isFinite(acres)
          ? t('{n} acres', { n: Math.round(acres).toLocaleString() })
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
    .filter((at) => distanceKm(here, at) <= radiusKm);
  if (hits.length) {
    const nearest = hits.reduce((a, b) =>
      distanceKm(here, a) <= distanceKm(here, b) ? a : b,
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
  const value = Number(code);
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
