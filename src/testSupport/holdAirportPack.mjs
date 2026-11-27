import { _setAirportsFetchForTest } from '../data/airports.js';

/** Hold a fixture catalog until the test releases its pending lookup. */
export function holdAirportPack(t, rows) {
  const request = Promise.withResolvers();
  const gate = Promise.withResolvers();
  _setAirportsFetchForTest(async () => {
    request.resolve();
    await gate.promise;
    return Response.json({ meta: {}, rows });
  });
  t.after(() => {
    gate.resolve();
    _setAirportsFetchForTest(null);
  });
  return { requested: request.promise, release: gate.resolve };
}
