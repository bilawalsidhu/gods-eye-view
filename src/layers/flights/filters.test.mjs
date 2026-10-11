import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightFilters } from './filters.js';

function fixture(getEnrichment = async () => ({ found: false })) {
  const records = new Map([
    ['abc123', { callsign: ' BAW123 ', airline: 'British Airways' }],
    ['abc124', { callsign: 'BAW12A' }],
    ['abc125', { callsign: 'EZY123' }],
    ['abc126', { callsign: '', registration: 'N123BA' }],
  ]);
  const released = [],
    tracked = [],
    cleared = [];
  const flightState = {
    feed: { _source: { getEnrichment }, _lastUpdate: 1, _count: records.size },
    records: { data: records },
    _billboards: new Map([...records].map(([id]) => [id, { show: true }])),
    _viewer: { scene: { requestRender() {} } },
  };
  const parts = {
    rendering: { _releaseModel: (id) => released.push(id) },
    tracking: {
      _clearTracking: (...args) => {
        cleared.push(args);
        flightState._trackedIcao = null;
      },
    },
  };
  const layer = {
    trackById: (id, options) => {
      tracked.push([id, options]);
      return true;
    },
  };
  const filters = createFlightFilters({ flightState, parts, layer });
  return { filters, flightState, records, released, tracked, cleared };
}
const baw = {
  found: true,
  airlines: [{ name: 'British Airways', iata: 'BA', icao: 'BAW' }],
};

test('IATA and ICAO select the same operator; numeric and alphanumeric callsigns match exactly by prefix', async () => {
  const calls = [];
  const f = fixture(async (query) => {
    calls.push(query);
    return baw;
  });
  assert.equal(
    await f.filters.methods.setFlightFilters({ airline: ' ba ' }),
    true,
  );
  assert.equal(f.filters.count(), 2);
  assert.equal(f.filters.countLabel(), '2 / 4');
  assert.deepEqual(f.filters.methods.getFlightFilters().operators, ['BAW']);
  assert.equal(f.filters.matches('abc125', f.records.get('abc125')), false);
  assert.equal(
    f.filters.matches('abc126', f.records.get('abc126')),
    false,
    'tail suffix is not an operator code',
  );
  assert.deepEqual(calls, [{ kind: 'airline', id: 'BA' }]);
  assert.equal(
    await f.filters.methods.setFlightFilters({ airline: 'BAW' }),
    true,
  );
  assert.equal(f.filters.count(), 2);
  assert.equal(f.records.size, 4, 'acquisition records are retained');
  assert.deepEqual(f.released.slice(0, 2), ['abc125', 'abc126']);
});

test('provider outages retain direct ICAO filtering and reject unresolved IATA without changing the prior filter', async () => {
  const f = fixture(async () => {
    throw new Error('offline');
  });
  assert.equal(
    await f.filters.methods.setFlightFilters({ airline: 'BAW' }),
    true,
  );
  assert.equal(
    await f.filters.methods.setFlightFilters({ airline: 'BA' }),
    false,
  );
  assert.equal(
    f.filters.matches('unknown', {}),
    false,
    'missing callsigns cannot match or break the cache',
  );
  assert.equal(f.filters.methods.getFlightFilters().airline, 'BAW');
  assert.match(
    f.filters.methods.getRowControls().info,
    /IATA code unavailable/,
  );
});

test('flight numbers use the provider’s actual callsign alias, including different commercial and ATC numbers', async () => {
  const f = fixture(async ({ kind }) =>
    kind === 'airline'
      ? baw
      : { found: true, callsignIata: 'BA999', callsignIcao: 'BAW12A' },
  );
  assert.equal(
    await f.filters.methods.setFlightFilters({
      airline: 'BA',
      flight: ' BA 999 ',
    }),
    true,
  );
  assert.equal(f.filters.count(), 1);
  assert.equal(f.filters.matches('abc124', f.records.get('abc124')), true);
  assert.equal(f.filters.matches('abc123', f.records.get('abc123')), false);
  assert.deepEqual(f.filters.methods.getFlightFilters().callsigns, ['BAW12A']);
});

test('unmapped numbers are rejected; observed and direct ICAO callsigns work without enrichment', async () => {
  const f = fixture();
  assert.equal(
    await f.filters.methods.setFlightFilters({ flight: 'BA123' }),
    false,
  );
  assert.equal(f.filters.active(), false);
  assert.equal(
    await f.filters.methods.setFlightFilters({ flight: 'BAW123' }),
    true,
  );
  assert.equal(f.filters.count(), 1, 'BAW123 does not also select BAW12A');
  assert.equal(
    await f.filters.methods.setFlightFilters({ flight: 'BAW999' }),
    true,
  );
  assert.equal(f.filters.count(), 0, 'absent live flights remain empty');
});

test('cached matches notice an in-place callsign change and fresh polls update the options', async () => {
  const f = fixture();
  await f.filters.methods.setFlightFilters({ airline: 'BAW' });
  const info = f.records.get('abc125');
  assert.equal(f.filters.matches('abc125', info), false);
  info.callsign = 'BAW456';
  assert.equal(f.filters.matches('abc125', info), true);
  f.flightState.feed._lastUpdate++;
  assert.equal(f.filters.count(), 3);
  assert.ok(
    f.filters.methods
      .getRowControls()
      .form.fields[2].options.some((option) => option.value === 'abc125'),
  );
});

test('a late lookup cannot replace a newer filter or survive clear/cancel', async () => {
  let resolve;
  const f = fixture(({ id }) =>
    id === 'BA'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ found: false }),
  );
  const first = f.filters.methods.setFlightFilters({ airline: 'BA' });
  await f.filters.methods.setFlightFilters({ airline: 'EZY' });
  resolve(baw);
  assert.equal(await first, false);
  assert.equal(f.filters.methods.getFlightFilters().airline, 'EZY');
  const second = f.filters.methods.setFlightFilters({ airline: 'BA' });
  f.filters.methods.clearFlightFilters();
  resolve(baw);
  assert.equal(await second, false);
  assert.equal(f.filters.active(), false);
  const third = f.filters.methods.setFlightFilters({ airline: 'BA' });
  f.filters.cancel();
  resolve(baw);
  assert.equal(await third, false);
});

test('a selected loaded flight uses stable identity, follows through the existing tracker, and clear restores the cohort', async () => {
  const f = fixture();
  const choose = f.filters.methods
    .getRowControls()
    .form.actions.find((action) => action.id === 'choose').onClick;
  assert.equal(
    choose({ selected: 'abc126' }),
    true,
    'callsign-less aircraft can still be chosen',
  );
  assert.equal(f.filters.active(), true);
  assert.equal(f.filters.count(), 1);
  assert.equal(f.filters.matches('abc123', f.records.get('abc123')), false);
  assert.deepEqual(f.tracked, [['abc126', { origin: 'user' }]]);
  f.filters.methods.clearFlightFilters();
  assert.equal(f.filters.count(), 4);
  f.flightState._trackedIcao = 'abc125';
  await f.filters.methods.setFlightFilters({ airline: 'BAW' });
  assert.equal(
    f.cleared.length,
    1,
    'excluded tracked entity is removed as well as its billboard',
  );
});

test('the flight selector is bounded and filters validate before calling the source', async () => {
  let requests = 0;
  const f = fixture(async () => {
    requests++;
    return baw;
  });
  for (let i = 0; i < 500; i++)
    f.records.set(`id${i}`, { callsign: `BAW${i}` });
  f.flightState.feed._count = f.records.size;
  assert.equal(
    f.filters.methods.getRowControls().form.fields[2].options.length,
    201,
  );
  assert.equal(
    await f.filters.methods.setFlightFilters({ airline: 'https://host' }),
    false,
  );
  assert.equal(
    await f.filters.methods.setFlightFilters({ flight: '../../etc' }),
    false,
  );
  assert.equal(requests, 0);
});
