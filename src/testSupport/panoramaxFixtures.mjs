// Panoramax stand-ins for tests and the hermetic QA gate: vector tiles in
// the meta-catalogue's shape, and STAC items.
import { PbfWriter } from 'pbf';
import {
  layerWriter,
  lineGeometry,
  zigzag,
} from '../layers/streetLevel/providers/mapillary/coverageFixture.mjs';

/** Tile-local [x, y] (0..extent) of a lon/lat inside tile (x, y, z). */
function lonLatToTileLocal([lon, lat], { x, y, z }, extent = 4096) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const tx = ((lon + 180) / 360) * n;
  const ty =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [Math.round((tx - x) * extent), Math.round((ty - y) * extent)];
}

/**
 * Encode a Panoramax `/api/map/{z}/{x}/{y}.mvt` tile from lon/lat features.
 * @param {{x: number, y: number, z: number}} tile
 * @param {{sequences?: Array<{id: string, date?: string, type?: string, parts: Array<Array<[number, number]>>}>, grid?: Array<{lon: number, lat: number, pano?: number, flat?: number}>, pictures?: Array<{id: string, lon: number, lat: number, sequenceId: string, heading?: number, ts?: string, type?: string}>, extent?: number}} [content]
 */
export function encodePanoramaxTile(
  tile,
  { sequences = [], grid = [], pictures = [], extent = 4096 } = {},
) {
  const pbf = new PbfWriter();
  if (sequences.length) {
    const layer = layerWriter('sequences', extent);
    for (const sequence of sequences)
      layer.add(
        2,
        lineGeometry(
          sequence.parts.map((part) =>
            part.map((point) => lonLatToTileLocal(point, tile, extent)),
          ),
        ),
        {
          id: sequence.id,
          type: sequence.type ?? 'flat',
          date: sequence.date ?? '2025-06-01',
          model: 'Test camera',
        },
      );
    pbf.writeMessage(3, (_, out) => layer.write(out), null);
  }
  const point = (lon, lat) => {
    const [px, py] = lonLatToTileLocal([lon, lat], tile, extent);
    return [9, zigzag(px), zigzag(py)];
  };
  if (grid.length) {
    const layer = layerWriter('grid', extent);
    for (const cell of grid) {
      const pano = cell.pano ?? 0;
      const flat = cell.flat ?? 1;
      layer.add(1, point(cell.lon, cell.lat), {
        nb_pictures: pano + flat,
        nb_360_pictures: pano,
        nb_flat_pictures: flat,
      });
    }
    pbf.writeMessage(3, (_, out) => layer.write(out), null);
  }
  if (pictures.length) {
    const layer = layerWriter('pictures', extent);
    for (const picture of pictures)
      layer.add(1, point(picture.lon, picture.lat), {
        id: picture.id,
        ts: picture.ts ?? '2025-06-01 10:00:00+00',
        heading: picture.heading ?? 90,
        sequences: JSON.stringify([picture.sequenceId]),
        first_sequence: picture.sequenceId,
        type: picture.type ?? 'flat',
      });
    pbf.writeMessage(3, (_, out) => layer.write(out), null);
  }
  return new Uint8Array(pbf.finish());
}

/**
 * A STAC item as the meta-catalogue returns it.
 * @param {{id: string, lon: number, lat: number, sequenceId?: string, heading?: number, pano?: boolean, datetime?: string, producer?: string, license?: string, width?: number, prevId?: string|null, nextId?: string|null, host?: string}} options
 */
export function stacItem({
  id,
  lon,
  lat,
  sequenceId = 'seq-1',
  heading = 90,
  pano = false,
  datetime = '2025-06-01T10:00:00+00:00',
  producer = 'tester',
  license = 'CC-BY-SA-4.0',
  width = pano ? 5760 : 4032,
  prevId = null,
  nextId = null,
  host = 'https://panoramax.example.org',
}) {
  const api = 'https://api.panoramax.xyz/api';
  const links = [
    { rel: 'self', href: `${api}/collections/${sequenceId}/items/${id}` },
  ];
  if (prevId)
    links.push({
      rel: 'prev',
      href: `${api}/collections/${sequenceId}/items/${prevId}`,
    });
  if (nextId)
    links.push({
      rel: 'next',
      href: `${api}/collections/${sequenceId}/items/${nextId}`,
    });
  return {
    type: 'Feature',
    id,
    collection: sequenceId,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    providers: [{ name: producer, roles: ['producer'] }],
    properties: {
      datetime,
      license,
      'view:azimuth': heading,
      'geovisio:producer': producer,
      'pers:interior_orientation': {
        ...(pano ? { field_of_view: 360 } : {}),
        sensor_array_dimensions: [width, pano ? width / 2 : 3024],
      },
    },
    assets: {
      hd: { href: `${host}/pictures/${id}/hd.jpg` },
      sd: { href: `${host}/pictures/${id}/sd.jpg` },
      thumb: { href: `${host}/pictures/${id}/thumb.jpg` },
    },
    links,
  };
}
