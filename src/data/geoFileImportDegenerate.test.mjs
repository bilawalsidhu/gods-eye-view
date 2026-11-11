// A file whose only geometry is degenerate (a one-point line, a two-point
// ring) draws nothing; main refused it with "That file has nothing to draw.".
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGeoFile, GeoImportError } from './geoFileImport.js';

const geojson = (geometry) => {
  const blob = new Blob([
    JSON.stringify({ type: 'Feature', properties: {}, geometry }),
  ]);
  blob.name = 'degenerate.geojson';
  return blob;
};

for (const geometry of [
  { type: 'LineString', coordinates: [[1, 2]] },
  {
    type: 'Polygon',
    coordinates: [
      [
        [1, 2],
        [2, 3],
      ],
    ],
  },
]) {
  test(`a ${geometry.type} with nothing to draw is refused`, async () => {
    await assert.rejects(
      loadGeoFile(geojson(geometry)),
      (error) =>
        error instanceof GeoImportError &&
        /nothing to draw/.test(error.message),
    );
  });
}
