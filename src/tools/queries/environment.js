/**
 * Environment queries: weather, regional briefs, cyclones, fire perimeters,
 * terrain height, mapped military sites and map features.
 */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  polygonsTouchArea,
  resolveArea,
  resolvePoint,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';

const MAX_TERRAIN_POINTS = 20;
const MAX_SITE_BOX_DEGREES = 10;
const FEATURE_KINDS = {
  administrative_areas: 'getAdministrativeAreas',
  named_places: 'getEnclosingAreas',
  monuments: 'getMonuments',
};

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

// WMO weather interpretation codes used by the weather provider.
const WEATHER_CODES = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light rain showers',
  81: 'rain showers',
  82: 'violent rain showers',
  85: 'light snow showers',
  86: 'snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with light hail',
  99: 'thunderstorm with heavy hail',
};

function weatherRow(weather) {
  if (!weather) return null;
  return {
    observed_at: weather.observedAt ?? null,
    conditions: WEATHER_CODES[weather.weatherCode] ?? null,
    weather_code: weather.weatherCode ?? null,
    temperature_c: weather.temperatureC ?? null,
    feels_like_c: weather.apparentTemperatureC ?? null,
    precipitation_mm: weather.precipitationMm ?? null,
    cloud_cover_pct: weather.cloudCoverPct ?? null,
    wind_kph: weather.windKph ?? null,
    wind_direction_deg: weather.windDirectionDeg ?? null,
    visibility_m: weather.visibilityM ?? null,
  };
}

function describeWeather(row) {
  if (!row) return 'no current weather';
  const parts = [
    row.conditions,
    Number.isFinite(row.temperature_c) && `${Math.round(row.temperature_c)}°C`,
    Number.isFinite(row.wind_kph) && `wind ${Math.round(row.wind_kph)} km/h`,
  ].filter(Boolean);
  return parts.join(', ') || 'conditions unknown';
}

export const getWeather = defineTool({
  name: 'get_weather',
  title: 'Current weather',
  description:
    'Current weather at a location: conditions, temperature, feels-like, ' +
    'precipitation, cloud cover, wind and visibility.',
  inputSchema: {
    type: 'object',
    properties: { location: POINT_SCHEMA },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['weather'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const payload = await services.weather.getConditions(point.lat, point.lon, {
      signal,
    });
    const row = weatherRow(payload?.weather);
    // The proxy answers from its cache, marked stale, when a refresh fails.
    const stale = payload?.status === 'stale';
    return {
      summary:
        `Weather at ${point.label}: ${describeWeather(row)}` +
        (stale ? ' (data may be stale).' : '.'),
      data: {
        location: point,
        weather: row,
        stale,
        retrieved_at: payload?.retrievedAt ?? null,
      },
    };
  },
});

export const getRegionalBrief = defineTool({
  name: 'get_regional_brief',
  title: 'Regional brief',
  description:
    'What and where a location is, its current weather, and recent news ' +
    'headlines for the region.',
  inputSchema: {
    type: 'object',
    properties: { location: POINT_SCHEMA },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['regional'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const brief = await services.regional.getBrief(point.lat, point.lon, {
      signal,
    });
    const place = brief?.place ?? null;
    const articles = (brief?.articles || []).slice(0, 10).map((article) => ({
      title: article.title ?? null,
      url: article.url ?? null,
      source: article.domain ?? null,
      published_at: article.publishedAt ?? null,
    }));
    const weather = weatherRow(brief?.weather);
    const label = place?.label || point.label;
    return {
      summary: `${label}: ${describeWeather(weather)}; ${countNoun(articles.length, 'recent headline')}.`,
      data: {
        location: point,
        place: place && {
          label: place.label ?? null,
          locality: place.locality ?? null,
          region: place.region ?? null,
          country: place.country ?? null,
          kind: place.kind ?? null,
        },
        weather,
        news_source: brief?.newsSource ?? null,
        articles,
      },
    };
  },
});

export const getCyclones = defineTool({
  name: 'get_cyclones',
  title: 'Tropical cyclones',
  description:
    'Active tropical cyclones from the NOAA National Hurricane Center and ' +
    'Central Pacific Hurricane Center, optionally limited to an area.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    additionalProperties: false,
  },
  requires: ['cyclones'],
  async run(args, { services, signal }) {
    const area = args.area
      ? await resolveArea(args.area, { services, signal })
      : null;
    const snapshot = await services.cyclones.getSnapshot({ signal });
    if (snapshot.unavailable)
      throw new ToolError(
        'unavailable',
        'Cyclone advisories are unavailable right now',
      );
    const storms = snapshot.storms
      .filter(
        (storm) =>
          !area ||
          areaContains(area, {
            lat: storm.position.latitude,
            lon: storm.position.longitude,
          }),
      )
      .map((storm) => ({
        id: storm.id,
        name: storm.name,
        classification: storm.classification,
        basin: storm.basin,
        lat: storm.position.latitude,
        lon: storm.position.longitude,
        position_at: storm.positionAt,
        wind_kt: storm.windKt,
        pressure_hpa: storm.pressureHpa,
        movement: storm.movement ?? null,
        advisory: storm.advisoryNumber,
        issued_at: storm.issuedAt,
        advisory_url: storm.advisoryUrl,
      }))
      .sort((a, b) => (b.wind_kt ?? 0) - (a.wind_kt ?? 0));
    const where = area ? ` in ${area.label}` : '';
    return {
      summary:
        `${countNoun(storms.length, 'active tropical cyclone')}${where}` +
        (storms[0]
          ? `; strongest ${storms[0].name} at ${storms[0].wind_kt} kt.`
          : '.'),
      data: {
        view: suggestView(
          services,
          area
            ? { area, layers: ['weather-cyclones'] }
            : {
                point: { lat: 20, lon: 0 },
                altitudeM: 15_000_000,
                layers: ['weather-cyclones'],
              },
        ),
        storms,
        coverage: snapshot.coverage ?? null,
        source: snapshot.source ?? null,
        attribution: snapshot.attribution ?? null,
        stale: snapshot.stale === true,
      },
    };
  },
});

export const getFirePerimeters = defineTool({
  name: 'get_fire_perimeters',
  title: 'Wildfire perimeters',
  description:
    'Mapped wildfire perimeters from the US WFIGS service in an area, ' +
    'largest first, with size, containment, cause and personnel.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['perimeters'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const rows = (await services.perimeters.getSnapshot({ signal }))
      .filter((fire) => polygonsTouchArea(fire.polygons, area))
      .map((fire) => ({ fire, point: polygonCenter(fire.polygons) }))
      .filter(({ point }) => point)
      .map(({ fire, point }) => ({
        id: fire.stableId,
        name: fire.name,
        acres: round(fire.acres, 0),
        contained_pct: fire.containedPct,
        state: fire.state,
        county: fire.county,
        category: fire.category,
        cause: fire.cause,
        behavior: fire.behavior,
        personnel: fire.personnel,
        discovered: isoTime(fire.discoveredTime),
        updated: isoTime(fire.updatedTime),
        lat: round(point.lat, 5),
        lon: round(point.lon, 5),
      }))
      .sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
    return {
      summary: `${countNoun(rows.length, 'mapped wildfire perimeter')} in ${area.label}.`,
      data: {
        view: suggestView(services, { area, layers: ['fire-perimeters'] }),
        ...capRows(rows, args.limit),
      },
    };
  },
});

/** The average vertex of a perimeter's outer rings, enough to place it in an area. */
function polygonCenter(polygons) {
  let lat = 0;
  let lon = 0;
  let count = 0;
  for (const polygon of polygons || []) {
    for (const [x, y] of polygon?.[0] || []) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      lon += x;
      lat += y;
      count += 1;
    }
  }
  return count ? { lat: lat / count, lon: lon / count } : null;
}

export const getTerrainHeight = defineTool({
  name: 'get_terrain_height',
  title: 'Terrain height',
  description:
    'Ground elevation above sea level at up to 20 points, with the geoid ' +
    'and ellipsoid heights.',
  inputSchema: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TERRAIN_POINTS,
        items: {
          type: 'object',
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lon: { type: 'number', minimum: -180, maximum: 180 },
          },
          required: ['lat', 'lon'],
          additionalProperties: false,
        },
      },
    },
    required: ['points'],
    additionalProperties: false,
  },
  requires: ['terrain'],
  async run(args, { services, signal }) {
    const results = await services.terrain.getHeights(args.points, { signal });
    if (!Array.isArray(results) || results.length !== args.points.length)
      throw new ToolError('malformed', 'Terrain heights were incomplete');
    const rows = args.points.map((point, index) => ({
      lat: point.lat,
      lon: point.lon,
      elevation_m: round(results[index]?.elevation, 1),
      geoid_m: round(results[index]?.geoid, 1),
      ellipsoid_m: round(results[index]?.ellipsoid, 1),
    }));
    const first = rows[0];
    return {
      summary:
        rows.length === 1
          ? `Ground elevation is ${first.elevation_m ?? 'unknown'} m at ${first.lat}, ${first.lon}.`
          : `Ground elevation at ${countNoun(rows.length, 'point')}.`,
      data: { points: rows },
    };
  },
});

const NAMES_WAIT_MS = 5000;

/**
 * The value `promise` resolves to within `ms`, or null when it takes longer
 * or fails. Rejects only when `signal` aborts.
 */
function settleWithin(promise, ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => done(null), ms);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => done(value ?? null),
      () => done(null),
    );
  });
}

export const findMilitaryInstallations = defineTool({
  name: 'find_military_installations',
  title: 'Military installations',
  description:
    'Military installations mapped in OpenStreetMap within an area of at ' +
    `most ${MAX_SITE_BOX_DEGREES}° on each side, nearest the center first.`,
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['installations'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    if (
      area.west > area.east ||
      area.north - area.south > MAX_SITE_BOX_DEGREES ||
      area.east - area.west > MAX_SITE_BOX_DEGREES
    )
      throw new ToolError(
        'invalid_arguments',
        `The area must be at most ${MAX_SITE_BOX_DEGREES}° on each side and not cross the antimeridian`,
      );
    const center = areaCenter(area);
    let result = await services.installations.getMappedSites(area, {
      exact: true,
      thinned: false,
      signal,
    });
    // Tile results can arrive before the name pack; wait briefly for the
    // named version rather than answer with generic names.
    let namesPending = false;
    if (result.enrichment) {
      const named = await settleWithin(
        result.enrichment,
        NAMES_WAIT_MS,
        signal,
      );
      if (named) result = named;
      else namesPending = true;
    }
    // A saturated source returned only part of the mapped sites.
    const complete = !result.saturated;
    const rows = (result.records || [])
      .map((site) => ({
        site,
        point: { lat: site.latitude, lon: site.longitude },
      }))
      .filter(({ point }) => areaContains(area, point))
      .map(({ site, point }) => ({
        id: site.id,
        name: site.name ?? null,
        kind: site.kind ?? null,
        class: site.class ?? null,
        lat: round(point.lat, 5),
        lon: round(point.lon, 5),
        distance_km: round(distanceKm(center, point), 1),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    const notes = [
      ...(complete ? [] : ['partial: the source returned only some sites']),
      ...(namesPending ? ['site names are still loading'] : []),
    ];
    return {
      summary:
        `${countNoun(rows.length, 'mapped military installation')} in ${area.label}` +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(services, {
          area,
          layers: ['military-installations'],
        }),
        ...capRows(rows, args.limit),
        complete,
        names_pending: namesPending,
        source: result.source ?? null,
      },
    };
  },
});

export const getMapFeatures = defineTool({
  name: 'get_map_features',
  title: 'Map features',
  description:
    'Named OpenStreetMap features at a location: the administrative areas ' +
    'containing it, named parks, land uses and water nearby, or monuments ' +
    'and memorials within 2.5 km.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      kind: { type: 'string', enum: Object.keys(FEATURE_KINDS) },
      limit: LIMIT_SCHEMA,
    },
    required: ['location', 'kind'],
    additionalProperties: false,
  },
  requires: ['features'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const features = await services.features[FEATURE_KINDS[args.kind]](
      { lat: point.lat, lon: point.lon },
      { signal },
    );
    if (features?.unavailable)
      throw new ToolError(
        'unavailable',
        'Map feature lookups need an Overpass server configured for this app',
      );
    if (!Array.isArray(features))
      throw new ToolError(
        'retry_later',
        'The map feature service did not answer',
      );
    const rows = features
      .map((feature) => ({
        id: feature.id,
        name:
          feature.names?.english ||
          feature.names?.primary ||
          feature.names?.official ||
          null,
        category: feature.category,
        admin_level: feature.level === 99 ? null : feature.level,
        lat: round(feature.point?.lat, 5),
        lon: round(feature.point?.lon, 5),
      }))
      .filter((row) => row.name)
      .sort((a, b) => (a.admin_level ?? 99) - (b.admin_level ?? 99));
    const kind = args.kind.replace('_', ' ');
    return {
      summary: `${countNoun(rows.length, 'named feature')} (${kind}) at ${point.label}.`,
      data: { location: point, ...capRows(rows, args.limit) },
    };
  },
});
