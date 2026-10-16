/** Automated license plate reader cameras mapped in OpenStreetMap. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun } from '../results.js';

const MAX_SIDE_DEGREES = 3;

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export const findAlprCameras = defineTool({
  name: 'find_alpr_cameras',
  title: 'License plate reader cameras',
  description:
    'Automated license plate reader (ALPR) cameras mapped in OpenStreetMap ' +
    'in a US or Canadian area of at most 3° per side, nearest the center ' +
    'first, with operator, manufacturer and facing direction.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['alpr'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    if (
      area.west > area.east ||
      area.north - area.south > MAX_SIDE_DEGREES ||
      area.east - area.west > MAX_SIDE_DEGREES
    )
      throw new ToolError(
        'invalid_arguments',
        `The area must be at most ${MAX_SIDE_DEGREES}° on each side and not cross the antimeridian`,
      );
    const box = {
      west: area.west,
      south: area.south,
      east: area.east,
      north: area.north,
    };
    const result = await services.alpr.fetch(box, signal);
    if (result.noCoverage)
      return {
        summary: `${area.label} is outside the US and Canadian camera coverage.`,
        data: { ...capRows([], args.limit), coverage: 'US and Canada' },
      };
    if (result.zoomIn)
      throw new ToolError(
        'invalid_arguments',
        'Use a smaller, city-sized area',
      );
    const center = areaCenter(area);
    const rows = result.records
      .map((camera) => ({
        camera,
        point: { lat: camera.latitude, lon: camera.longitude },
      }))
      .filter(({ point }) => areaContains(area, point))
      .map(({ camera, point }) => ({
        id: camera.id,
        lat: round(point.lat, 6),
        lon: round(point.lon, 6),
        operator: camera.operator || null,
        manufacturer: camera.manufacturer || null,
        camera_type: camera.cameraType || null,
        zone: camera.zone || null,
        direction_deg: camera.directionDeg ?? null,
        last_verified: camera.lastVerified || null,
        distance_km: round(distanceKm(center, point), 2),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    const notes = [
      ...(result.saturated
        ? ['partial: some cameras were not loaded; use a smaller area']
        : []),
      ...(result.stale ? ['data may be stale'] : []),
    ];
    return {
      summary:
        `${countNoun(rows.length, 'license plate reader camera')} mapped in ${area.label}` +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(services, { area, layers: ['alpr-cameras'] }),
        ...capRows(rows, args.limit),
        // Some tiles failed, or a dense area was trimmed to the source limit.
        complete: !result.saturated,
        stale: result.stale === true,
        source: services.alpr.label ?? null,
        attribution: services.alpr.attribution ?? null,
      },
    };
  },
});
