import { readFileSync } from 'node:fs';
import { decodeFlowTile } from '../src/layers/traffic/flowDecode.js';
import { tilesForBounds } from '../src/data/tomtomTiles.js';

const tile = readFileSync(
  new URL(
    '../src/data/fixtures/tomtom-flow-austin-12-935-1686.pbf',
    import.meta.url,
  ),
);
const json = (body) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Reuse the recorded flow tile for an explicitly synthetic browser exercise. */
export function trafficFixtureResponse(request) {
  const url = new URL(request.url());
  if (url.pathname === '/api/tomtom/status')
    return json({ hasKey: true, dailyCount: 0 });
  if (/^\/api\/tomtom\/flow\/\d+\/\d+\/\d+\.pbf$/.test(url.pathname))
    return { status: 200, contentType: 'application/x-protobuf', body: tile };
  if (url.pathname !== '/api/overpass') return null;
  const query = new URLSearchParams(request.postData()).get('data') || '';
  if (!query.includes('highway')) return null;
  const match = query.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  if (!match) throw new Error('Missing road fixture viewport');
  const [south, west, north, east] = match.slice(1).map(Number);
  const inside = ([lon, lat]) =>
    lat >= south && lat <= north && lon >= west && lon <= east;
  const segments = tilesForBounds({ south, west, north, east }, 12).flatMap(
    ({ z, x, y }) => decodeFlowTile(tile, z, x, y),
  );
  const elements = segments
    .filter((segment) => segment.coords.some(inside))
    .slice(0, 240)
    .map((segment, index) => ({
      type: 'way',
      id: index + 1,
      tags: { highway: 'primary', oneway: 'yes' },
      geometry: segment.coords.map(([lon, lat]) => ({ lon, lat })),
    }));
  const latitude = (south + north) / 2,
    longitude = (west + east) / 2;
  elements.push({
    type: 'way',
    id: 99999,
    tags: { highway: 'residential' },
    geometry: [
      { lat: latitude, lon: longitude },
      { lat: latitude + 0.003, lon: longitude + 0.003 },
    ],
  });
  return json({ elements });
}
