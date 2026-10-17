/** Weather map imagery (radar, satellite, lightning) and wind at a point. */

import { suggestView } from '../views.js';
import { windFrom } from '../../layers/wind/inspection.js';
import { sampleWind, windSpeed } from '../../layers/wind/model.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  areaRadiusKm,
  resolveArea,
  resolvePoint,
} from '../area.js';
import { toBase64 } from '../results.js';

/** Map names offered to callers, and the weather products behind them. */
const MAPS = {
  radar: 'radar',
  satellite: 'clouds-regional',
  global_satellite: 'clouds',
  lightning: 'lightning',
};
/** The app layer that shows each map. */
const MAP_LAYERS = {
  radar: 'weather-radar',
  satellite: 'weather-satellite',
  global_satellite: 'weather-satellite',
  lightning: 'weather-lightning',
};
const IMAGE_SIZE = { width: 1024, height: 512 };
const SNAP_DEGREES = 0.25;
const MIN_HALF_HEIGHT_DEGREES = 0.5;
const KM_PER_DEGREE = 111.2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const snapDown = (value) => Math.floor(value / SNAP_DEGREES) * SNAP_DEGREES;
const snapUp = (value) => Math.ceil(value / SNAP_DEGREES) * SNAP_DEGREES;
const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/**
 * A 2:1 box snapped to 0.25° around the area, moved inside the product's
 * bounds. Returns null when no such box covers the whole area (it would not
 * fit, or the area crosses the antimeridian), meaning the whole extent
 * should be shown instead.
 */
export function weatherWindow(area, bounds) {
  if (area.west > area.east) return null;
  const center = areaCenter(area);
  const halfHeight = Math.max(
    MIN_HALF_HEIGHT_DEGREES,
    areaRadiusKm(area) / KM_PER_DEGREE,
  );
  const height = snapUp(halfHeight * 2);
  const width = height * 2;
  if (width > bounds.east - bounds.west || height > bounds.north - bounds.south)
    return null;
  let west = snapDown(center.lon - width / 2);
  let south = snapDown(center.lat - height / 2);
  west = Math.min(
    Math.max(west, snapUp(bounds.west)),
    snapDown(bounds.east - width),
  );
  south = Math.min(
    Math.max(south, snapUp(bounds.south)),
    snapDown(bounds.north - height),
  );
  const mapBox = { west, south, east: west + width, north: south + height };
  const insideProduct =
    mapBox.west >= bounds.west &&
    mapBox.east <= bounds.east &&
    mapBox.south >= bounds.south &&
    mapBox.north <= bounds.north;
  // Moving the box inside the product can uncover part of the area; only a
  // box that still holds the whole area (clipped to the product) will do.
  const coversArea =
    mapBox.west <= Math.max(area.west, bounds.west) &&
    mapBox.east >= Math.min(area.east, bounds.east) &&
    mapBox.south <= Math.max(area.south, bounds.south) &&
    mapBox.north >= Math.min(area.north, bounds.north);
  return insideProduct && coversArea ? mapBox : null;
}

export const getWeatherMap = defineTool({
  name: 'get_weather_map',
  title: 'Weather map',
  description:
    'The latest NOAA weather map image over an area: precipitation radar ' +
    '(contiguous US), regional or global infrared satellite clouds, or ' +
    'lightning density (the Americas). Returns the image itself.',
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', enum: Object.keys(MAPS) },
      area: AREA_SCHEMA,
    },
    required: ['map'],
    additionalProperties: false,
  },
  requires: ['weatherMaps'],
  async run(args, { services, signal }) {
    const product = MAPS[args.map];
    const snapshot = await services.weatherMaps.getSnapshot({
      product,
      signal,
    });
    if (snapshot.unavailable)
      throw new ToolError(
        'unavailable',
        `The ${args.map} map is unavailable right now`,
      );
    const area = args.area
      ? await resolveArea(args.area, { services, signal })
      : null;
    let mapBox = null;
    if (area) {
      const { bounds } = snapshot;
      const center = areaCenter(area);
      if (
        center.lon < bounds.west ||
        center.lon > bounds.east ||
        center.lat < bounds.south ||
        center.lat > bounds.north
      )
        throw new ToolError(
          'invalid_arguments',
          `${area.label} is outside the ${args.map} map's coverage: ${snapshot.coverage || 'see its bounds'}`,
        );
      mapBox = weatherWindow(area, bounds);
    }
    const image = await services.weatherMaps.getImage({
      product,
      time: snapshot.latest,
      size: IMAGE_SIZE,
      bbox: mapBox,
      signal,
    });
    if (!/^image\/(png|jpeg)$/.test(image.contentType))
      throw new ToolError('unavailable', 'The weather map returned no image');
    if (image.bytes.byteLength > MAX_IMAGE_BYTES)
      throw new ToolError('unavailable', 'The weather map image is too large');
    const where = area ? ` over ${area.label}` : '';
    return {
      summary: `${snapshot.title || args.map} at ${snapshot.latest}${where}.`,
      data: {
        view: suggestView(
          services,
          area
            ? { area, layers: [MAP_LAYERS[args.map]] }
            : {
                point: {
                  lat: (snapshot.bounds.south + snapshot.bounds.north) / 2,
                  lon: (snapshot.bounds.west + snapshot.bounds.east) / 2,
                },
                altitudeM: 8_000_000,
                layers: [MAP_LAYERS[args.map]],
              },
        ),
        map: args.map,
        title: snapshot.title ?? null,
        description: snapshot.description ?? null,
        coverage: snapshot.coverage ?? null,
        time: snapshot.latest,
        box: mapBox ?? snapshot.bounds,
        source: snapshot.source ?? null,
        attribution: snapshot.attribution ?? null,
      },
      images: [{ mimeType: image.contentType, data: toBase64(image.bytes) }],
    };
  },
});

export const getWind = defineTool({
  name: 'get_wind',
  title: 'Wind',
  description:
    'Forecast wind 10 m above ground at a location from the GFS or IFS ' +
    'global model: speed and the direction it blows from.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      model: { type: 'string', enum: ['gfs', 'ifs'] },
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['wind'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const model = args.model ?? 'gfs';
    const snapshot = await services.wind.getSnapshot({ model, signal });
    if (snapshot.unavailable || !snapshot.u || !snapshot.v)
      throw new ToolError(
        'unavailable',
        'Wind forecasts are unavailable right now',
      );
    const vector = sampleWind(
      { ...snapshot.grid, u: snapshot.u, v: snapshot.v },
      point.lon,
      point.lat,
    );
    const speed = windSpeed(vector.u, vector.v);
    const from = windFrom(vector.u, vector.v);
    const kph = speed * 3.6;
    return {
      summary:
        `Wind at ${point.label}: ${kph.toFixed(0)} km/h` +
        (from === 'Calm' ? ', calm.' : ` from the ${from}.`),
      data: {
        view: suggestView(services, {
          point,
          altitudeM: 2_000_000,
          layers: ['wind'],
        }),
        location: point,
        speed_mps: round(speed, 1),
        speed_kph: round(kph, 1),
        from: from === 'Calm' ? null : from,
        calm: from === 'Calm',
        u_mps: round(vector.u, 2),
        v_mps: round(vector.v, 2),
        level: snapshot.level ?? '10 m above ground',
        model,
        cycle: snapshot.cycle ?? null,
      },
    };
  },
});
