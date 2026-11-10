import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlightNumberSearch,
  fetchAirlinesByCode,
} from './flightNumberSearch.js';

const ZX = { name: 'Example Airline', iata: 'ZX', icao: 'ZXY' };

/** A layer whose findByQuery ranks like the real one: exact callsign, else prefix. */
function fakeLayer(contacts) {
  return {
    findByQuery(query) {
      const q = String(query).trim().toUpperCase();
      const exact = contacts.find((c) => c.callsign.trim() === q);
      const prefix = contacts.find((c) => c.callsign.trim().startsWith(q));
      return exact || prefix || null;
    },
  };
}

function searchWith({ flights = [], military = [], enabled = {}, airlines } = {}) {
  const asked = [];
  const search = createFlightNumberSearch({
    readLayer: (layerId) => ({
      enabled: enabled[layerId] ?? true,
      module: fakeLayer(layerId === 'military' ? military : flights),
    }),
    lookupAirlines: async (code) => {
      asked.push(code);
      return airlines ?? { status: 'found', airlines: [ZX] };
    },
  });
  return { search, asked };
}

test('typed IATA, ICAO and spaced forms find the same loaded aircraft', async () => {
  const plane = { icao24: 'abc123', callsign: 'ZXY123  ' };
  const { search } = searchWith({ flights: [plane] });
  for (const text of ['ZX123', 'zx 123', 'ZXY123']) {
    const result = await search.find(text);
    assert.equal(result.status, 'found', text);
    assert.equal(result.layerId, 'flights');
    assert.equal(result.match, plane);
  }
});

test('a prefix match is not the typed flight', async () => {
  const { search } = searchWith({
    flights: [{ icao24: 'abc123', callsign: 'ZXY1234' }],
  });
  const result = await search.find('ZX 123');
  assert.equal(result.status, 'none');
  assert.equal(result.reason, 'no-contact');
});

test('two aircraft broadcasting candidate callsigns need a choice', async () => {
  const { search } = searchWith({
    flights: [{ icao24: 'aaa111', callsign: 'ZXY7' }],
    military: [{ icao24: 'bbb222', callsign: 'ZXO7' }],
    airlines: {
      status: 'found',
      airlines: [ZX, { name: 'Former', iata: 'ZX', icao: 'ZXO' }],
    },
  });
  const result = await search.find('ZX7');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.matches.map(({ layerId, match }) => [layerId, match.icao24]),
    [
      ['flights', 'aaa111'],
      ['military', 'bbb222'],
    ],
  );
});

test('a miss says whether layers are off, the airline is unknown or the lookup failed', async () => {
  const off = searchWith({ enabled: { flights: false, military: false } });
  assert.equal((await off.search.find('ZX1')).reason, 'layers-off');
  assert.deepEqual(off.asked, []);

  const unknown = searchWith({ airlines: { status: 'unknown' } });
  assert.equal((await unknown.search.find('ZX1')).reason, 'airline-unknown');

  const down = searchWith({ airlines: { status: 'unavailable' } });
  assert.equal((await down.search.find('ZX1')).reason, 'airline-unavailable');
});

test('an ICAO callsign needs no airline lookup, and places are left alone', async () => {
  const { search, asked } = searchWith({
    flights: [{ icao24: 'abc123', callsign: 'ZXY9' }],
  });
  assert.equal((await search.find('ZXY9')).status, 'found');
  assert.equal((await search.find('Paris')).status, 'not-flight');
  assert.deepEqual(asked, []);
});

test('airline answers are cached, outages are asked again', async () => {
  let calls = 0;
  let answer = { status: 'unavailable' };
  const search = createFlightNumberSearch({
    readLayer: () => ({ enabled: true, module: fakeLayer([]) }),
    lookupAirlines: async () => {
      calls++;
      return answer;
    },
  });
  await search.find('ZX1');
  await search.find('ZX2');
  assert.equal(calls, 2);
  answer = { status: 'found', airlines: [ZX] };
  await search.find('ZX3');
  await search.find('ZX4');
  assert.equal(calls, 3);
});

test('fetchAirlinesByCode reads the proxy answer and reports failures', async () => {
  const respond = (status, body) => async (url) => {
    assert.equal(url, '/api/adsbdb/airline/ZX');
    return { ok: status === 200, status, json: async () => body };
  };
  assert.deepEqual(
    await fetchAirlinesByCode('ZX', {
      fetchImpl: respond(200, { found: true, airlines: [ZX] }),
    }),
    { status: 'found', airlines: [ZX] },
  );
  assert.deepEqual(
    await fetchAirlinesByCode('ZX', { fetchImpl: respond(200, { found: false }) }),
    { status: 'unknown' },
  );
  assert.deepEqual(
    await fetchAirlinesByCode('ZX', { fetchImpl: respond(502, {}) }),
    { status: 'unavailable' },
  );
  assert.deepEqual(
    await fetchAirlinesByCode('ZX', {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    { status: 'unavailable' },
  );
});
