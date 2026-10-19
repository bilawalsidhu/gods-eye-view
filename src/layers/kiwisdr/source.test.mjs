import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiwiSdrSource } from './source.js';

const good = {
  id: 'abc12345',
  name: 'Rx',
  host: 'a.example.com',
  port: 8073,
  lat: 1,
  lon: 2,
  users: 0,
  usersMax: 4,
};
const reply =
  (body, ok = true, status = 200) =>
  async () => ({ ok, status, json: async () => body });

test('returns valid stations and drops malformed rows', async () => {
  const source = createKiwiSdrSource({
    fetchImpl: reply({
      fetchedAt: 'now',
      stations: [
        good,
        { ...good, id: 'x', lat: 99 },
        null,
        { ...good, port: 0 },
      ],
    }),
  });
  const out = await source.getDirectory();
  assert.equal(out.stations.length, 1);
  assert.equal(out.fetchedAt, 'now');
});

test('rejects http errors, bad bodies and empty directories', async () => {
  await assert.rejects(
    createKiwiSdrSource({ fetchImpl: reply({}, false, 502) }).getDirectory(),
    /502/,
  );
  await assert.rejects(
    createKiwiSdrSource({ fetchImpl: reply({}) }).getDirectory(),
    /Malformed/,
  );
  await assert.rejects(
    createKiwiSdrSource({ fetchImpl: reply({ stations: [] }) }).getDirectory(),
    /empty/,
  );
});

test('honours an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createKiwiSdrSource({ fetchImpl: reply({}) }).getDirectory({
      signal: controller.signal,
    }),
  );
});

test('puts the proxy failure reason in the error text', async () => {
  await assert.rejects(
    createKiwiSdrSource({
      fetchImpl: reply(
        { error: 'kiwisdr_unavailable', reason: 'kiwisdr_fetch_failed' },
        false,
        502,
      ),
    }).getDirectory(),
    /502 \(kiwisdr_fetch_failed\)/,
  );
  // An unexpected reason is never echoed into the UI.
  await assert.rejects(
    createKiwiSdrSource({
      fetchImpl: reply({ reason: '<script>' }, false, 502),
    }).getDirectory(),
    (error) => /502$/.test(error.message),
  );
});
