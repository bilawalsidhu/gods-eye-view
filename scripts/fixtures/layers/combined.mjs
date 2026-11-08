const ORIGIN = { lat: 42.3554, lon: -71.0605 };
const grid = (i, cols, spacing) => ({
  lat: ORIGIN.lat + (Math.floor(i / cols) - cols / 2) * spacing,
  lon: ORIGIN.lon + ((i % cols) - cols / 2) * spacing,
});
const bikes = Array.from({ length: 200 }, (_, i) => ({
  station_id: `fixture-bike-${i}`,
  name: `Fixture station ${i}`,
  capacity: 20,
  ...grid(i, 15, 0.0015),
}));
export const combinedPayloads = { bikes };

/** Bikeshare and startup feed fixtures shared by both engines. */
export async function installCombinedFixture(page) {
  const requests = [];
  const session = await page.createCDPSession();
  await session.send('Fetch.enable', {
    patterns: ['127.0.0.1', 'localhost'].map((host) => ({
      urlPattern: `http://${host}:*/api/*`,
    })),
  });
  let disposed = false;
  session.on('Fetch.requestPaused', async (event) => {
    try {
      const u = new URL(event.request.url);
      let body;
      const p = u.pathname;
      if (p.startsWith('/api/gbfs/'))
        body = {
          version: '3.0',
          data: {
            stations: decodeURIComponent(u.href).includes('station_information')
              ? bikes
              : bikes.map(({ station_id }) => ({
                  station_id,
                  num_bikes_available: 7,
                  num_docks_available: 13,
                  is_renting: true,
                  is_returning: true,
                })),
          },
        };
      else if (p === '/api/flights') body = { states: [] };
      else if (p === '/api/military') body = { ac: [] };
      else if (p === '/api/vessels') body = { connected: false, vessels: [] };
      else if (p === '/api/google/nearby-places') body = { places: [] };
      else if (p === '/api/setup/status') body = { ready: true };
      else if (p === '/api/terrain/heights')
        body = {
          results: (u.searchParams.get('points') || '')
            .split(';')
            .filter(Boolean)
            .map((point) => {
              const [lon, lat] = point.split(',').map(Number);
              return { lon, lat, elevation: 20, geoid: 0, ellipsoid: 20 };
            }),
        };
      if (body === undefined) {
        await session.send('Fetch.continueRequest', {
          requestId: event.requestId,
        });
        return;
      }
      requests.push(p);
      await session.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Expose-Headers', value: 'Data-Present' },
          { name: 'Data-Present', value: 'true' },
        ],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      });
    } catch (error) {
      if (
        !disposed &&
        !page.isClosed() &&
        !String(error.message).includes('Invalid InterceptionId')
      )
        page.emit('pageerror', error);
    }
  });
  return {
    requests,
    async dispose() {
      disposed = true;
      await session.detach();
    },
  };
}
