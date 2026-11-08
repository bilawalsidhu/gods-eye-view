export const TRANSIT_EPOCH = 1_793_232_000_000;
const routes = ['1', 'Green-B', 'Red', 'CR-Fitchburg', 'Boat-F1', ''];
export function transitSnapshot(step = 8) {
  const fetchedAt = TRANSIT_EPOCH - 135000 + step * 15000;
  return {
    fetchedAt,
    vehicles: [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `fixture-${i}`,
        routeId: routes[i % 6],
        tripId: `trip-${i}`,
        lat:
          42.355 +
          (Math.floor(i / 4) - 1) * 0.0017 +
          (i < 6 ? step * 0.00012 : 0),
        lon: -71.065 + ((i % 4) - 1.5) * 0.0017,
        timestamp: fetchedAt / 1000,
        timestampSource: 'vehicle',
        bearing: 0,
      })),
      {
        id: 'stale',
        routeId: '1',
        tripId: 'old',
        lat: 42.355,
        lon: -71.065,
        timestamp: (TRANSIT_EPOCH - 900000) / 1000,
        timestampSource: 'vehicle',
      },
    ],
  };
}
export async function installTransitFixture(page) {
  let step = 0,
    disposed = false;
  const requests = [];
  const session = await page.createCDPSession();
  await page.evaluateOnNewDocument((epoch) => {
    Date.now = () => epoch + performance.now();
  }, TRANSIT_EPOCH);
  await session.send('Fetch.enable', {
    patterns: ['localhost', '127.0.0.1'].flatMap((host) =>
      [
        '/api/transit/*',
        '/api/flights*',
        '/api/military*',
        '/api/vessels*',
      ].map((route) => ({ urlPattern: `http://${host}:*${route}` })),
    ),
  });
  session.on('Fetch.requestPaused', async (event) => {
    try {
      const url = new URL(event.request.url);
      requests.push(url.pathname);
      let body;
      if (url.pathname.startsWith('/api/transit/vehicles/'))
        body = url.pathname.endsWith('/mbta')
          ? transitSnapshot(step)
          : { fetchedAt: TRANSIT_EPOCH, vehicles: [] };
      else if (url.pathname.startsWith('/api/transit/trail/')) {
        const vehicleId = decodeURIComponent(url.pathname.split('/').at(-1));
        const record = transitSnapshot().vehicles.find(
          (row) => row.id === vehicleId,
        );
        body = {
          version: 1,
          feedId: 'mbta',
          vehicleId,
          truncated: false,
          epochs: [
            { id: 1, trip: record.tripId, route: record.routeId, mode: 'bus' },
          ],
          fixes: Array.from({ length: 9 }, (_, i) => {
            const snapshot = transitSnapshot(i),
              row = snapshot.vehicles.find((v) => v.id === vehicleId);
            return [snapshot.fetchedAt, row.lat, row.lon, 0, 1];
          }),
        };
      } else body = { states: [], ac: [], vessels: [], feeds: [] };
      await session.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      });
    } catch (error) {
      if (!disposed && !page.isClosed()) page.emit('pageerror', error);
    }
  });
  return {
    requests,
    setStep(value) {
      step = value;
    },
    async dispose() {
      disposed = true;
      await session.detach();
    },
  };
}
