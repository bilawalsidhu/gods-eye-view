import { PbfWriter } from 'pbf';

// Recorded journeys cover both a dense neighbourhood and the wider Austin view.
export const cameras = [
  ...Array.from({ length: 225 }, (_, i) => ({
    latitude: 30.262 + (Math.floor(i / 15) - 7) * 0.003,
    longitude: -97.7431 + ((i % 15) - 7) * 0.003,
  })),
  ...Array.from({ length: 100 }, (_, i) => ({
    latitude: 30.308 + (Math.floor(i / 10) - 4.5) * 0.001,
    longitude: -97.77 + ((i % 10) - 4.5) * 0.001,
  })),
].map((position, i) => ({
  ...position,
  osmId: 9000000 + i,
  operator: i % 3 ? 'Deterministic fixture' : 'Cámara pública',
  brand: 'Fixture camera',
  cameraType: 'fixed',
  direction: i % 5 ? String((i * 37) % 360) : '',
}));

export function cameraTile(z, x, y, records = cameras) {
  const extent = 4096;
  const scale = 2 ** z;
  const rows = records.flatMap((record) => {
    const latitude = (record.latitude * Math.PI) / 180;
    const tx = ((record.longitude + 180) / 360) * scale;
    const ty = ((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2) * scale;
    if (Math.floor(tx) !== x || Math.floor(ty) !== y) return [];
    return [
      {
        record,
        x: Math.round((tx - x) * extent),
        y: Math.round((ty - y) * extent),
      },
    ];
  });
  const keys = [
    'osmType',
    'osmId',
    'operator',
    'brand',
    'cameraType',
    'direction',
  ];
  const writer = new PbfWriter();
  writer.writeMessage(
    3,
    (_, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'cameras');
      layer.writeVarintField(5, extent);
      for (const key of keys) layer.writeStringField(3, key);
      rows.forEach(({ record, x, y }, index) => {
        for (const key of keys)
          layer.writeMessage(
            4,
            (_, value) =>
              value.writeStringField(
                1,
                key === 'osmType' ? 'node' : String(record[key]),
              ),
            null,
          );
        layer.writeMessage(
          2,
          (_, feature) => {
            feature.writeVarintField(1, record.osmId);
            feature.writePackedVarint(
              2,
              keys.flatMap((_, i) => [i, index * keys.length + i]),
            );
            feature.writeVarintField(3, 1);
            feature.writePackedVarint(4, [9, x * 2, y * 2]);
          },
          null,
        );
      });
    },
    null,
  );
  return Buffer.from(writer.finish());
}

/** Real TileJSON/MVT transport; no replacement of the layer or source parser. */
export async function installAlprFixture(page) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    const url = new URL(request.url());
    // The journey also asks for nearby-place labels while moving. Pin that
    // auxiliary service; these runs do not test Google Places availability.
    if (
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.pathname === '/api/google/nearby-places'
    ) {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ places: [] }),
      });
      return;
    }
    if (url.hostname !== 'tiles.dontgetflocked.com') {
      void request.continue();
      return;
    }
    const headers = { 'access-control-allow-origin': '*' };
    if (url.pathname.endsWith('.json')) {
      const country = url.pathname.includes('-ca-') ? 'ca' : 'us';
      void request.respond({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({
          tiles: [
            `https://tiles.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
          ],
          bounds: country === 'ca' ? [-124, 42, -63, 54] : [-160, 17, -64, 59],
        }),
      });
      return;
    }
    const match = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
    void request.respond({
      status: match ? 200 : 404,
      headers,
      contentType: 'application/x-protobuf',
      body: match ? cameraTile(...match.slice(1).map(Number)) : '',
    });
  });
}
