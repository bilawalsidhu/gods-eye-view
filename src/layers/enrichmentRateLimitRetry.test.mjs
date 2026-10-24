// A 429 from /api/adsbdb must not leave an aircraft's metadata empty for the
// rest of the session.
//
// Both enrichment queues (Flights and Local ADS-B) mark a key as seen before
// they dispatch it, so a second request for the same aircraft is dropped. That
// is right for an answer or a 404, and wrong for a refusal: the server said
// "later", not "no". These cases drive the real queues against a source that
// refuses once and then answers.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSourceError } from '../sources/live/contract.js';
import { createLocalAdsbEnrichment } from './localAdsb/enrichment.js';
import { createFlightState } from './flights/state.js';
import { createEnrichment } from './flights/enrichment.js';

/** Short real delay, so the case needs no clock control. */
const RETRY_AFTER_MS = 20;

/** A source that refuses the first lookup with a 429, then answers. */
function refusingOnce() {
  const calls = [];
  return {
    calls,
    async getEnrichment(query) {
      calls.push(query);
      if (calls.length === 1)
        throw new LiveSourceError('limited', 'Flights rate limited', {
          status: 429,
          retryAfterMs: RETRY_AFTER_MS,
        });
      return { found: true, typeCode: 'B738', typeName: 'Boeing 737-800' };
    },
  };
}

const settle = (ms) => new Promise((done) => setTimeout(done, ms));

test('Local ADS-B asks again after a 429 once the refusal has passed', async (t) => {
  const source = refusingOnce();
  const enrichment = createLocalAdsbEnrichment({ source, onChange() {} });
  t.after(() => enrichment.destroy());
  const record = { icao: 'abc123', category: 'A3' };

  enrichment.request(record);
  await settle(0);
  assert.equal(source.calls.length, 1);
  enrichment.request(record);
  await settle(0);
  assert.equal(source.calls.length, 1, 'no retry inside the refusal window');

  await settle(RETRY_AFTER_MS + 250); // refusal window, then the 200 ms drip
  enrichment.request(record);
  await settle(250);
  assert.equal(source.calls.length, 2, 'the aircraft is asked for again');
  assert.equal(enrichment.get('abc123')?.typeCode, 'B738');
});

test('an answered lookup is still asked for only once', async (t) => {
  const calls = [];
  const enrichment = createLocalAdsbEnrichment({
    source: {
      async getEnrichment(query) {
        calls.push(query);
        return { found: false };
      },
    },
    onChange() {},
  });
  t.after(() => enrichment.destroy());
  enrichment.request({ icao: 'def456' });
  await settle(RETRY_AFTER_MS + 250);
  enrichment.request({ icao: 'def456' });
  await settle(250);
  assert.equal(calls.length, 1, 'a 404 is an answer, not a refusal');
});

test('Flights asks again after a 429 once the refusal has passed', async (t) => {
  const source = refusingOnce();
  const flightState = createFlightState({
    source,
    services: {
      groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    },
  });
  t.after(() => flightState.lifetime.abort());
  const enrichment = createEnrichment({ flightState, services: {}, parts: {} });
  let applied = null;
  const ask = () =>
    enrichment._enqueueEnrich(
      't:abc123',
      { kind: 'type', id: 'abc123' },
      (data) => {
        applied = data;
      },
    );

  ask();
  await settle(0);
  ask();
  await settle(0);
  assert.equal(source.calls.length, 1, 'no retry inside the refusal window');

  await settle(RETRY_AFTER_MS + 250);
  ask();
  await settle(250);
  assert.equal(source.calls.length, 2, 'the aircraft is asked for again');
  assert.equal(applied?.typeCode, 'B738');
});
