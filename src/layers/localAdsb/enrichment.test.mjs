import assert from 'node:assert/strict';
import test from 'node:test';
import { ENRICH_RETRY_COOLDOWN_MS } from '../flights/policy.js';
import { createLocalAdsbEnrichment } from './enrichment.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, status) {
  const clock = { now: 100_000 };
  const queries = [];
  let fail = true;
  const enrichment = createLocalAdsbEnrichment({
    now: () => clock.now,
    source: {
      getEnrichment(query) {
        queries.push(query.id);
        if (fail)
          throw Object.assign(new Error(`adsbdb HTTP ${status}`), { status });
        return { found: true, typeCode: 'B407' };
      },
    },
  });
  t.after(() => enrichment.destroy());
  return {
    queries,
    enrichment,
    async request() {
      enrichment.request({ icao: 'abc123' });
      await settle();
      await settle();
    },
    recover() {
      fail = false;
      clock.now += ENRICH_RETRY_COOLDOWN_MS + 1;
    },
  };
}

test('a temporary adsbdb failure is asked again after the cool-down', async (t) => {
  const app = harness(t, 503);
  await app.request();
  assert.deepEqual(app.queries, ['abc123']);
  await app.request();
  assert.equal(app.queries.length, 1, 'not within the cool-down');
  app.recover();
  await app.request();
  assert.deepEqual(app.queries, ['abc123', 'abc123']);
  assert.equal(app.enrichment.get('abc123').typeCode, 'B407');
});

test('a 404 from adsbdb is final', async (t) => {
  const app = harness(t, 404);
  await app.request();
  app.recover();
  await app.request();
  assert.deepEqual(app.queries, ['abc123']);
});
