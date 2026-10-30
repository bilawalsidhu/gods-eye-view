import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldValue,
  normalizeSncfStation,
  normalizeSncfStationPage,
  loadSncfStations,
} from './sncf.js';

test('normalizeSncfStation reads the geo position', () => {
  const row = normalizeSncfStation({
    id: 'abc',
    nom: 'Châteauroux',
    libellecourt: 'CTX',
    codes_uic: '87597005',
    segment_drg: 'A',
    position_geographique: { lon: 1.699536, lat: 46.809737 },
  });
  assert.equal(row.id, 'abc');
  assert.equal(row.name, 'Châteauroux');
  assert.equal(row.shortCode, 'CTX');
  assert.equal(row.uic, '87597005');
  assert.equal(row.lon, 1.699536);
  assert.equal(row.lat, 46.809737);
});

test('a record body is read from its fields, with the top level as fallback', () => {
  // The v1 records API serves the record BODY: the fields live under
  // `fields`, not at the top level. Reading only the top level resolves
  // every name, short code, UIC and coordinate to null against this shape,
  // and the row falls back to its id - a station with no name on the map.
  const row = normalizeSncfStation({
    datasetid: 'gares-de-voyageurs',
    recordid: '4d8a52161d8b188e1b09942cad1d108922e3455d',
    fields: {
      nom: 'Chateauroux',
      libellecourt: 'CTX',
      segment_drg: 'A',
      codes_uic: '87597005',
      codeinsee: '36044',
      id: '0054eed7-a134-4fca-b217-d65e4d2ea153',
      position_geographique: { lon: 1.699536, lat: 46.809737 },
    },
    geometry: { type: 'Point', coordinates: [1.699536, 46.809737] },
    record_timestamp: '2026-10-27T13:43:01.95Z',
  });
  assert.equal(row.id, '0054eed7-a134-4fca-b217-d65e4d2ea153');
  assert.equal(row.name, 'Chateauroux');
  assert.equal(row.shortCode, 'CTX');
  assert.equal(row.uic, '87597005');
  assert.equal(row.segment, 'A');
  assert.equal(row.lon, 1.699536);
  assert.equal(row.lat, 46.809737);
});

test('a flattened record is still read from its top level', () => {
  // The v2.1 catalogue API serves the SAME dataset flattened. The fallback
  // keeps that shape working, so the provider does not depend on which ODS
  // endpoint the catalogue happens to answer.
  const row = normalizeSncfStation({
    nom: 'Montry - Conde',
    libellecourt: 'MYD',
    segment_drg: 'C',
    codes_uic: '87116400',
    id: '00ed0a78-cec6-4246-9781-b0d7fc47e7c7',
    position_geographique: { lon: 2.8262345, lat: 48.8908268 },
  });
  assert.equal(row.id, '00ed0a78-cec6-4246-9781-b0d7fc47e7c7');
  assert.equal(row.name, 'Montry - Conde');
  assert.equal(row.shortCode, 'MYD');
  assert.equal(row.uic, '87116400');
  assert.equal(row.segment, 'C');
  assert.equal(row.lon, 2.8262345);
  assert.equal(row.lat, 48.8908268);
});

test('the record body wins where a record carries the field in both places', () => {
  const row = normalizeSncfStation({
    nom: 'the top level name',
    fields: { nom: 'the body name' },
    position_geographique: { lon: 1, lat: 46 },
  });
  assert.equal(row.name, 'the body name');
});

test('a record with neither shape keeps its fallback id', () => {
  const row = normalizeSncfStation({
    fields: { codes_uic: '87597005', position_geographique: { lon: 1.5, lat: 46.5 } },
  });
  assert.equal(row.id, '87597005');
  assert.equal(row.name, null);
  assert.equal(row.shortCode, null);
});

test('fieldValue reads the body first and the top level second', () => {
  assert.equal(fieldValue({ fields: { a: 1 } }, 'a'), 1);
  assert.equal(fieldValue({ a: 2 }, 'a'), 2);
  assert.equal(fieldValue({ fields: { a: 1 }, a: 2 }, 'a'), 1);
  assert.equal(fieldValue({ fields: { a: null }, a: 2 }, 'a'), 2);
  assert.equal(fieldValue(null, 'a'), undefined);
  assert.equal(fieldValue({}, 'a'), undefined);
});

test('normalizeSncfStation rejects a row without coordinates', () => {
  assert.equal(normalizeSncfStation({ nom: 'Nowhere' }), null);
  assert.equal(normalizeSncfStation({ position_geographique: {} }), null);
});

test('normalizeSncfStation rejects out-of-range coordinates', () => {
  assert.equal(
    normalizeSncfStation({ position_geographique: { lon: 999, lat: 10 } }),
    null,
  );
  assert.equal(
    normalizeSncfStation({ position_geographique: { lon: 10, lat: 999 } }),
    null,
  );
});

test('normalizeSncfStation falls back to the UIC code for an id', () => {
  const row = normalizeSncfStation({
    codes_uic: '87597005',
    position_geographique: { lon: 1.5, lat: 46.5 },
  });
  assert.equal(row.id, '87597005');
});

test('normalizeSncfStationPage reports the total and drops bad rows', () => {
  const page = normalizeSncfStationPage({
    total_count: 2,
    results: [
      { position_geographique: { lon: 1, lat: 46 } },
      { nom: 'broken' },
    ],
  });
  assert.equal(page.total, 2);
  assert.equal(page.rows.length, 1);
});

test('loadSncfStations pages the catalogue until the total is reached', async () => {
  // The upstream caps a page at 100 rows, so a full page is what keeps the
  // sweep going; the last page is the short one that ends it.
  const full = Array.from({ length: 100 }, (_, i) => ({
    position_geographique: { lon: 1 + i * 0.01, lat: 46 },
  }));
  const pages = [
    { total_count: 150, results: full },
    { total_count: 150, results: full.slice(0, 50) },
  ];
  let call = 0;
  const snapshot = await loadSncfStations(async () => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  assert.equal(call, 2, 'the sweep stops after the short final page');
  assert.equal(snapshot.count, 150);
  assert.equal(snapshot.total, 150);
  assert.ok(snapshot.fetchedAt > 0);
});

test('loadSncfStations stops on a short page', async () => {
  let call = 0;
  const snapshot = await loadSncfStations(async () => {
    call += 1;
    return new Response(
      JSON.stringify({
        total_count: 2,
        results: [
          { position_geographique: { lon: 1, lat: 46 } },
          { position_geographique: { lon: 2, lat: 47 } },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  assert.equal(call, 1);
  assert.equal(snapshot.count, 2);
});

test('loadSncfStations surfaces an upstream failure', async () => {
  await assert.rejects(
    loadSncfStations(async () => new Response('nope', { status: 500 })),
    /upstream HTTP 500/,
  );
});
