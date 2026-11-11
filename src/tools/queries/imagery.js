/** The most recent satellite image of an area. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import { AREA_SCHEMA, areaRadiusKm, resolveArea } from '../area.js';
import { toBase64 } from '../results.js';

const MAX_SIDE_KM = 1000;
const MAX_LATITUDE = 85;
const IMAGE_WIDTH = 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const SENSORS = {
  S30: 'Sentinel-2 (30 m)',
  L30: 'Landsat 8/9 (30 m)',
  VIIRS: 'VIIRS daily overview (250 m)',
};

export const getRecentImagery = defineTool({
  name: 'get_recent_imagery',
  title: 'Recent satellite image',
  description:
    'The most recent clear satellite image of an area from NASA Harmonized ' +
    'Landsat and Sentinel-2 (30 m), falling back to the VIIRS daily ' +
    `overview. Areas up to ${MAX_SIDE_KM} km across. Returns the image itself.`,
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['imagery'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    if (area.west > area.east)
      throw new ToolError(
        'invalid_arguments',
        'The area must not cross the antimeridian',
      );
    if (
      Math.abs(area.south) > MAX_LATITUDE ||
      Math.abs(area.north) > MAX_LATITUDE
    )
      throw new ToolError(
        'invalid_arguments',
        `Imagery stops at ±${MAX_LATITUDE}° latitude`,
      );
    if (areaRadiusKm(area) * 2 > MAX_SIDE_KM * Math.SQRT2)
      throw new ToolError(
        'invalid_arguments',
        `The area is too large for imagery; use one up to ${MAX_SIDE_KM} km across`,
      );
    const box = {
      west: area.west,
      south: area.south,
      east: area.east,
      north: area.north,
    };
    let latest;
    try {
      latest = await services.imagery.latest({ box, signal });
    } catch (error) {
      if (error instanceof TypeError)
        throw new ToolError('invalid_arguments', error.message);
      throw error;
    }
    const { candidate, reason } = latest;
    if (!candidate)
      return {
        summary: `No recent satellite image covers ${area.label}.`,
        data: { area: area.label, image: null },
      };
    const height = Math.max(
      64,
      Math.min(
        1024,
        Math.round(
          (IMAGE_WIDTH * (box.north - box.south)) / (box.east - box.west),
        ),
      ),
    );
    const image = await services.imagery.getSnapshot({
      product: candidate.product,
      day: candidate.day,
      box,
      width: IMAGE_WIDTH,
      height,
      signal,
    });
    if (!/^image\/(png|jpeg)$/.test(image.contentType))
      throw new ToolError(
        'unavailable',
        'The imagery service returned no image',
      );
    if (image.bytes.byteLength > MAX_IMAGE_BYTES)
      throw new ToolError('unavailable', 'The image is too large to return');
    const sensor = SENSORS[candidate.product] || candidate.product;
    const cloud = candidate.cloud
      ? `${Math.round(candidate.cloud.min)}–${Math.round(candidate.cloud.max)}% cloud`
      : 'cloud cover unknown';
    const quality = {
      clear: 'clear',
      cloudy: 'cloudy',
      partial: 'partly covering the area',
      overview: 'coarse overview',
    }[reason];
    return {
      summary: `Most recent image of ${area.label}: ${sensor}, ${candidate.day}, ${quality}${reason === 'overview' ? '' : `, ${cloud}`}.`,
      data: {
        view: suggestView(services, { area, layers: ['recent-imagery'] }),
        area: area.label,
        image: {
          product: candidate.product,
          sensor,
          day: candidate.day,
          quality: reason,
          cloud_pct: candidate.cloud ?? null,
          coverage: candidate.coverage ?? null,
        },
        search_errors: latest.errors?.map((error) => error.product) ?? [],
      },
      images: [{ mimeType: image.contentType, data: toBase64(image.bytes) }],
    };
  },
});
