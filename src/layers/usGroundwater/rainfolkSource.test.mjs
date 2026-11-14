import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sample from '../../../fixtures/us-groundwater/v1/expected-pack.json' with { type: 'json' };
import {
  createRainfolkWellSource,
  RAINFOLK_WELL_RELEASE,
} from './rainfolkSource.js';

test('published Rainfolk source is inert until requested and uses the exact immutable HTTPS directory', async () => {
  const calls = [];
  const source = createRainfolkWellSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('', { status: 503 });
    },
  });
  assert.equal(source.label, 'Rainfolk');
  assert.equal(calls.length, 0);
  await assert.rejects(source.getSnapshot({ bounds: null }), /HTTP 503/);
  assert.equal(
    calls[0].url,
    `https://data.rainfolk.org/usgwd/${RAINFOLK_WELL_RELEASE}/index.json`,
  );
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
});

test('release changes stay on the provider origin and malformed configuration fails before fetch', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response('', { status: 404 });
  };
  for (const release of [
    '',
    'latest',
    '../other',
    'https://other.invalid/',
    'a'.repeat(64) + '?key=x',
    'A'.repeat(64),
    48,
    null,
  ])
    assert.throws(
      () => createRainfolkWellSource({ release, fetchImpl }),
      /Invalid Rainfolk/,
    );
  assert.equal(calls.length, 0);
  await assert.rejects(
    createRainfolkWellSource({
      release: 'a'.repeat(64),
      fetchImpl,
    }).getSnapshot({ bounds: null }),
    /HTTP 404/,
  );
  assert.equal(
    calls[0],
    `https://data.rainfolk.org/usgwd/${'a'.repeat(64)}/index.json`,
  );
});

test('the configured release verifies root bytes on every check, before catalog publication', async () => {
  const body = JSON.stringify({
    schemaVersion: 1,
    kind: 'gev-well-spatial-index',
    regions: [],
    fallbackAcquisition: sample.acquisitions[0],
  });
  const release = createHash('sha256').update(body).digest('hex');
  let served = body;
  let published = 0;
  const source = createRainfolkWellSource({
    release,
    fetchImpl: async () => new Response(served),
    onCatalog: () => published++,
  });
  assert.equal((await source.getSnapshot()).records.length, 0);
  assert.equal(published, 1);
  // Even an equivalent JSON document has different bytes under this pinned root.
  served += ' ';
  await assert.rejects(source.getSnapshot(), /hash mismatch/);
  assert.equal(published, 1);
});
