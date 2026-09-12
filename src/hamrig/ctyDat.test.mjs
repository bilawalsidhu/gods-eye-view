import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CTY_URL,
  callAreaCentroid,
  createCtyResolver,
  loadCtyDatFileSync,
  parseCtyDat,
  resolveCallsign,
} from './ctyDat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXCERPT_PATH = path.join(here, 'fixtures', 'cty-excerpt.dat');
const SYNTHETIC_PATH = path.join(here, 'fixtures', 'cty-synthetic.dat');
const RUSSIA_PATH = path.join(here, 'fixtures', 'cty-russia.dat');
const EXCERPT = fs.readFileSync(EXCERPT_PATH, 'utf8');
const SYNTHETIC = fs.readFileSync(SYNTHETIC_PATH, 'utf8');
const COMBINED = `${EXCERPT}\n${SYNTHETIC}`;

const excerpt = parseCtyDat(EXCERPT);
const index = parseCtyDat(COMBINED);
// Real European Russia / Kaliningrad / Asiatic Russia lines incl. the 8F/9F, 8G/9G, 8X/9X blocks.
const russia = loadCtyDatFileSync(RUSSIA_PATH);
const entityByName = (idx, name) => idx.entities.find((e) => e.name === name);

// ---------------------------------------------------------------------------
// parseCtyDat
// ---------------------------------------------------------------------------

test('parseCtyDat reads every header of the real excerpt', () => {
  assert.equal(excerpt.entities.length, 21);
  assert.deepEqual(excerpt.entities.map((e) => e.primaryPrefix).slice(0, 5), ['1A', '1S', '3Y/b', '4U1U', '4U1V']);
  assert.ok(excerpt.exact instanceof Map);
  assert.ok(excerpt.prefixes instanceof Map);
  const malta = entityByName(excerpt, 'Sov Mil Order of Malta');
  assert.equal(malta.cq, 15);
  assert.equal(malta.itu, 28);
  assert.equal(malta.continent, 'EU');
});

test('parseCtyDat negates longitude: Spratly is at 114.23 E, the US at 91.87 W', () => {
  const spratly = entityByName(excerpt, 'Spratly Islands');
  assert.equal(spratly.lat, 9.88);
  assert.equal(spratly.lon, 114.23);
  assert.equal(spratly.utcOffset, 8);
  const usa = entityByName(excerpt, 'United States');
  assert.equal(usa.lon, -91.87);
  assert.equal(usa.utcOffset, -5);
});

test('parseCtyDat negates TZ: Germany has utcOffset +1, England 0', () => {
  assert.equal(entityByName(excerpt, 'Fed. Rep. of Germany').utcOffset, 1);
  assert.equal(entityByName(excerpt, 'England').utcOffset, 0);
  assert.equal(entityByName(excerpt, 'Hawaii').utcOffset, -10);
});

test('parseCtyDat strips the * WAE marker and flags waeOnly', () => {
  const vienna = entityByName(excerpt, 'Vienna Intl Ctr');
  assert.equal(vienna.primaryPrefix, '4U1V');
  assert.equal(vienna.waeOnly, true);
  const africanItaly = entityByName(excerpt, 'African Italy');
  assert.equal(africanItaly.primaryPrefix, 'IG9');
  assert.equal(africanItaly.waeOnly, true);
  assert.equal(entityByName(excerpt, 'Fed. Rep. of Germany').waeOnly, false);
  // WAE entries are kept apart from the DXCC maps.
  assert.equal(excerpt.prefixes.has('IG9'), false);
  assert.equal(excerpt.waePrefixes.has('IG9'), true);
  assert.equal(excerpt.exact.has('4U1VIC'), false);
  assert.equal(excerpt.waeExact.has('4U1VIC'), true);
  for (const key of excerpt.prefixes.keys()) assert.ok(!key.startsWith('*'), `prefix ${key} carries a *`);
});

test('parseCtyDat keeps = entries (including ones with /) in the exact map with their overrides', () => {
  const n2nl = excerpt.exact.get('N2NL/MM');
  assert.ok(n2nl, 'N2NL/MM is an exact entry');
  assert.equal(excerpt.entities[n2nl.entityIndex].name, 'United States');
  assert.equal(n2nl.cq, 7, 'cq override from (7)');
  assert.equal(n2nl.itu, 8, 'itu inherited from the entity');
  assert.ok(excerpt.exact.has('F6/4Z5KJ/LH'));
  assert.ok(excerpt.exact.has('R0CAF/1'));
  assert.ok(excerpt.exact.has('VE2/G3ZAY/P'));
  assert.equal(excerpt.exact.get('VE2/G3ZAY/P').itu, 4);
  assert.equal(excerpt.prefixes.has('N2NL/MM'), false);
});

test('parseCtyDat applies (cq)[itu] overrides per prefix token', () => {
  const aa0 = excerpt.prefixes.get('AA0');
  assert.equal(aa0.cq, 4);
  assert.equal(aa0.itu, 7);
  const aa = excerpt.prefixes.get('AA');
  assert.equal(aa.cq, 5);
  assert.equal(aa.itu, 8);
  assert.equal(excerpt.prefixes.get('VE2')?.itu, 4);
  assert.equal(excerpt.prefixes.get('VE')?.itu, 9);
});

test('parseCtyDat handles <lat/lon>{cont}~tz~ overrides in any order (synthetic fixture)', () => {
  const synthetic = parseCtyDat(SYNTHETIC);
  const qb = synthetic.prefixes.get('QB');
  assert.deepEqual(
    { cq: qb.cq, itu: qb.itu, continent: qb.continent, lat: qb.lat, lon: qb.lon, utcOffset: qb.utcOffset },
    { cq: 38, itu: 70, continent: 'AF', lat: 12.34, lon: 56.78, utcOffset: 3.5 },
  );
  const qc = synthetic.prefixes.get('QC');
  assert.deepEqual(
    { cq: qc.cq, itu: qc.itu, continent: qc.continent, lat: qc.lat, lon: qc.lon, utcOffset: qc.utcOffset },
    { cq: 33, itu: 45, continent: 'AS', lat: -45.67, lon: -123.45, utcOffset: -2 },
  );
  const qd = synthetic.prefixes.get('QD');
  assert.equal(qd.cq, 39);
  assert.equal(qd.itu, 71);
  assert.equal(qd.lat, 10, 'lat inherited');
  assert.equal(qd.lon, -20, 'entity lon negated');
  const exact = synthetic.exact.get('QA1TEST');
  assert.deepEqual({ lat: exact.lat, lon: exact.lon, continent: exact.continent, cq: exact.cq }, { lat: 1, lon: -2, continent: 'SA', cq: 9 });
  assert.equal(synthetic.exact.get('QA2MIX/P').utcOffset, 8);
});

test('parseCtyDat tolerates CRLF, blank lines, and junk', () => {
  const crlf = EXCERPT.replace(/\n/g, '\r\n');
  assert.equal(parseCtyDat(crlf).entities.length, 21);
  assert.equal(parseCtyDat('').entities.length, 0);
  assert.equal(parseCtyDat(null).entities.length, 0);
  assert.equal(parseCtyDat('garbage line without colons\n    DL;\n').entities.length, 0);
  const junkToken = parseCtyDat('Testland:  14:  28:  EU:  50.00:  -10.00:  -1.0:  QT:\n    QT,??bad,=QT1A;\n');
  assert.equal(junkToken.prefixes.size, 1);
  assert.equal(junkToken.exact.size, 1);
});

test('loadCtyDatFileSync reads a fixture from disk', () => {
  assert.equal(loadCtyDatFileSync(SYNTHETIC_PATH).entities.length, 8);
});

// ---------------------------------------------------------------------------
// resolveCallsign
// ---------------------------------------------------------------------------

test('DL1ABC resolves to Germany by prefix with entity precision', () => {
  const r = resolveCallsign(index, 'DL1ABC');
  assert.equal(r.entity, 'Fed. Rep. of Germany');
  assert.equal(r.primaryPrefix, 'DL');
  assert.equal(r.matchType, 'prefix');
  assert.equal(r.precision, 'entity');
  assert.equal(r.cq, 14);
  assert.equal(r.itu, 28);
  assert.equal(r.continent, 'EU');
  assert.equal(r.lat, 51);
  assert.equal(r.lon, 10);
  assert.equal(r.waeOnly, false);
  assert.equal(resolveCallsign(index, 'dl1abc').entity, 'Fed. Rep. of Germany', 'case-insensitive');
});

test('W1AW/7 swaps the call-area digit and returns US area 7 with precision area', () => {
  const r = resolveCallsign(index, 'W1AW/7');
  assert.equal(r.entity, 'United States');
  assert.equal(r.precision, 'area');
  assert.deepEqual({ lat: r.lat, lon: r.lon }, callAreaCentroid('W7AW'));
  assert.notDeepEqual({ lat: r.lat, lon: r.lon }, callAreaCentroid('W1AW'));
  const w1 = resolveCallsign(index, 'W1AW');
  assert.equal(w1.precision, 'area');
  assert.deepEqual({ lat: w1.lat, lon: w1.lon }, { lat: 43.5, lon: -71.5 });
});

test('UA9ABC/1 becomes UA1ABC → European Russia, while UA9ABC stays Asiatic', () => {
  const asiatic = resolveCallsign(index, 'UA9ABC');
  assert.equal(asiatic.entity, 'Asiatic Russia');
  assert.equal(asiatic.precision, 'area');
  assert.deepEqual({ lat: asiatic.lat, lon: asiatic.lon }, { lat: 57, lon: 70 });
  const european = resolveCallsign(index, 'UA9ABC/1');
  assert.equal(european.entity, 'European Russia');
  assert.equal(european.matchType, 'prefix');
  assert.equal(european.precision, 'area');
  assert.deepEqual({ lat: european.lat, lon: european.lon }, { lat: 60, lon: 35 });
  assert.equal(resolveCallsign(index, 'UA9ABC/P').matchType, 'exact');
  assert.equal(resolveCallsign(index, 'UA9ABC/P').entity, 'Asiatic Russia');
  // exact entry beats the digit-swap rule
  assert.equal(resolveCallsign(index, 'R0CAF/1').matchType, 'exact');
  assert.equal(resolveCallsign(index, 'R0CAF/1').entity, 'European Russia');
});

test('UA9X / UA9F / R8F / R9F blocks filed under European Russia get the west-of-Urals centroid, not West Siberia', () => {
  // cty.dat assigns Perm / Komi-Permyak / Komi (area digit 8 or 9) to European Russia (UA);
  // the digit table alone would place them at RU_AREAS[9] (57 N 70 E), ~900 km east.
  for (const call of ['UA9XO', 'UA9FAB', 'UA9GX', 'R9FA', 'R8FF', 'R9XC', 'RA9XAB', 'UA8XA']) {
    const r = resolveCallsign(russia, call);
    assert.ok(r, call);
    assert.equal(r.entity, 'European Russia', call);
    assert.equal(r.primaryPrefix, 'UA', call);
    assert.equal(r.matchType, 'prefix', call);
    assert.equal(r.precision, 'area', call);
    assert.deepEqual({ lat: r.lat, lon: r.lon }, { lat: 59, lon: 55 }, call);
  }
  const komi = resolveCallsign(russia, 'UA9XO');
  assert.equal(komi.cq, 17, 'token-level cq override is kept');
  assert.equal(komi.itu, 20);
  const perm = resolveCallsign(russia, 'UA9FAB');
  assert.equal(perm.cq, 17);
  assert.equal(perm.itu, 30);
  // Asiatic Russia (UA9) keeps the West Siberia / Far East centroids.
  for (const [call, expected] of [
    ['UA9CAB', { lat: 57, lon: 70 }],
    ['R9WA', { lat: 57, lon: 70 }],
    ['RA9AB', { lat: 57, lon: 70 }],
    ['R8CD', { lat: 58, lon: 65 }],
    ['UA0AA', { lat: 56, lon: 110 }],
  ]) {
    const r = resolveCallsign(russia, call);
    assert.equal(r.entity, 'Asiatic Russia', call);
    assert.equal(r.primaryPrefix, 'UA9', call);
    assert.equal(r.precision, 'area', call);
    assert.deepEqual({ lat: r.lat, lon: r.lon }, expected, call);
  }
  // European Russia areas 1-7 and Kaliningrad are untouched by the entity hint.
  assert.deepEqual([resolveCallsign(russia, 'UA1ABC').lat, resolveCallsign(russia, 'UA1ABC').lon], [60, 35]);
  assert.deepEqual([resolveCallsign(russia, 'R3AB').lat, resolveCallsign(russia, 'R3AB').lon], [55.5, 38]);
  assert.deepEqual([resolveCallsign(russia, 'UA6AA').lat, resolveCallsign(russia, 'UA6AA').lon], [45.5, 42]);
  const kgd = resolveCallsign(russia, 'UA2FF');
  assert.equal(kgd.entity, 'Kaliningrad');
  assert.equal(kgd.precision, 'entity', 'UA2 is not a large entity');
  assert.deepEqual([kgd.lat, kgd.lon], [54.72, 20.52]);
  // A /digit suffix still relocates a Komi call into that area.
  const moved = resolveCallsign(russia, 'UA9XO/1');
  assert.equal(moved.entity, 'European Russia');
  assert.deepEqual([moved.lat, moved.lon], [60, 35]);
  // Exact entries in the block still win over the prefix tokens.
  assert.equal(resolveCallsign(russia, 'R0CAF/1').matchType, 'exact');
  assert.equal(resolveCallsign(russia, 'R0CAF/1').entity, 'European Russia');
  assert.equal(resolveCallsign(russia, 'R0CAF').entity, 'Asiatic Russia');
});

test('F/DL1ABC resolves to France via the designator rule', () => {
  const r = resolveCallsign(index, 'F/DL1ABC');
  assert.equal(r.entity, 'France');
  assert.equal(r.matchType, 'designator');
  assert.equal(r.precision, 'entity');
  assert.equal(r.lon, 2);
});

test('DL1ABC/VK2 resolves to Australia (VK2 lacks callsign structure) with area precision', () => {
  const r = resolveCallsign(index, 'DL1ABC/VK2');
  assert.equal(r.entity, 'Australia');
  assert.equal(r.matchType, 'designator');
  assert.equal(r.precision, 'area');
  assert.deepEqual({ lat: r.lat, lon: r.lon }, { lat: -32.5, lon: 147 });
});

test('S79/DL2SBY resolves to Seychelles (S79 is the designator)', () => {
  const r = resolveCallsign(index, 'S79/DL2SBY');
  assert.equal(r.entity, 'Seychelles');
  assert.equal(r.matchType, 'designator');
  assert.equal(r.lat, -4.67);
  assert.equal(r.lon, 55.47);
});

test('N2NL/MM resolves to the USA through its exact entry, other /MM and /AM are null', () => {
  const r = resolveCallsign(index, 'N2NL/MM');
  assert.equal(r.entity, 'United States');
  assert.equal(r.matchType, 'exact');
  assert.equal(r.cq, 7);
  assert.equal(r.precision, 'entity', 'a maritime mobile has no call area');
  assert.equal(resolveCallsign(index, 'K1ABC/MM'), null);
  assert.equal(resolveCallsign(index, 'DL1ABC/AM'), null);
  assert.equal(resolveCallsign(index, 'DL1ABC/MM/P'), null);
  assert.equal(resolveCallsign(index, 'NQ4I/AM').matchType, 'exact');
});

test('IT9ABC resolves to Italy with allowWae=false and to Sicily with allowWae=true', () => {
  const dxcc = resolveCallsign(index, 'IT9ABC');
  assert.equal(dxcc.entity, 'Italy');
  assert.equal(dxcc.waeOnly, false);
  assert.equal(dxcc.matchType, 'prefix');
  const wae = resolveCallsign(index, 'IT9ABC', { allowWae: true });
  assert.equal(wae.entity, 'Sicily');
  assert.equal(wae.waeOnly, true);
  assert.equal(wae.lat, 37.5);
  assert.equal(wae.lon, 14);
  // exact entries that live only under a WAE entity fall back to DXCC prefixes
  assert.equal(resolveCallsign(index, 'II1MM/9').entity, 'Italy');
  assert.equal(resolveCallsign(index, 'II1MM/9', { allowWae: true }).entity, 'Sicily');
  assert.equal(resolveCallsign(index, '2M0BDR').entity, 'Scotland');
  // exact calls listed under both a WAE and a DXCC entity
  assert.equal(resolveCallsign(index, '4U1VIC').entity, 'Austria');
  assert.equal(resolveCallsign(index, '4U1VIC', { allowWae: true }).entity, 'Vienna Intl Ctr');
});

test('a WAE-only entity is returned as a last resort when nothing else matches', () => {
  const r = resolveCallsign(excerpt, '4U1VIC');
  assert.equal(r.entity, 'Vienna Intl Ctr');
  assert.equal(r.waeOnly, true);
  assert.equal(resolveCallsign(excerpt, 'IG9ABC').entity, 'African Italy');
});

test('4U1UN resolves to United Nations HQ through the exact map', () => {
  const r = resolveCallsign(index, '4U1UN');
  assert.equal(r.entity, 'United Nations HQ');
  assert.equal(r.matchType, 'exact');
  assert.equal(r.primaryPrefix, '4U1U');
  assert.equal(r.lat, 40.75);
  assert.equal(r.lon, -73.97);
  assert.equal(resolveCallsign(index, '4U1UNX'), null, '4U1U is not a list prefix');
});

test('prefix-only input resolves (TF, S79, J-less prefixes)', () => {
  assert.equal(resolveCallsign(index, 'TF').entity, 'Iceland');
  assert.equal(resolveCallsign(index, 'TF').lon, -18.73);
  assert.equal(resolveCallsign(index, 'S79').entity, 'Seychelles');
  assert.equal(resolveCallsign(index, 'S79').matchType, 'prefix');
  assert.equal(resolveCallsign(index, 'VR').entity, 'Hong Kong');
  assert.equal(resolveCallsign(index, 'KH6').entity, 'Hawaii');
});

test('AA0XX picks the AA0 override zones and the US area-0 centroid', () => {
  const r = resolveCallsign(index, 'AA0XX');
  assert.equal(r.entity, 'United States');
  assert.equal(r.cq, 4);
  assert.equal(r.itu, 7);
  assert.equal(r.precision, 'area');
  assert.deepEqual({ lat: r.lat, lon: r.lon }, { lat: 42, lon: -97 });
  const aa1 = resolveCallsign(index, 'AA1XX');
  assert.equal(aa1.cq, 5);
  assert.equal(aa1.itu, 8);
});

test('unknown calls and bad input resolve to null without throwing', () => {
  assert.equal(resolveCallsign(index, 'ZZ9ZZZ'), null);
  assert.equal(resolveCallsign(index, ''), null);
  assert.equal(resolveCallsign(index, null), null);
  assert.equal(resolveCallsign(index, undefined), null);
  assert.equal(resolveCallsign(index, '///'), null);
  assert.equal(resolveCallsign(index, 42), null);
  assert.equal(resolveCallsign(null, 'DL1ABC'), null);
  assert.equal(resolveCallsign({}, 'DL1ABC'), null);
  assert.equal(resolveCallsign(index, { toString() { throw new Error('boom'); } }), null);
});

test('trailing designators are peeled repeatedly, including unknown short suffixes', () => {
  assert.equal(resolveCallsign(index, 'DL1ABC/P').entity, 'Fed. Rep. of Germany');
  assert.equal(resolveCallsign(index, 'DL1ABC/QRP').entity, 'Fed. Rep. of Germany');
  assert.equal(resolveCallsign(index, 'DL1ABC/P/QRP').entity, 'Fed. Rep. of Germany');
  assert.equal(resolveCallsign(index, 'DL1ABC/M').entity, 'Fed. Rep. of Germany', '/M is mobile, not England');
  assert.equal(resolveCallsign(index, 'DL1ABC/LH').entity, 'Fed. Rep. of Germany', '/LH is lighthouse, not Norway');
  assert.equal(resolveCallsign(index, 'G3ABC/LGT').entity, 'England', 'unknown 3-letter suffix is peeled');
  assert.equal(resolveCallsign(index, 'GB2ELH/LH').entity, 'England');
  assert.equal(resolveCallsign(index, 'DL1ABC/70').entity, 'Fed. Rep. of Germany', 'multi-digit suffixes are peeled');
  assert.equal(resolveCallsign(index, 'DL1ABC/YL').entity, 'Latvia', 'a whole-prefix suffix is a designator');
  assert.equal(resolveCallsign(index, 'F/DL1ABC/P').entity, 'France');
  assert.equal(resolveCallsign(index, 'VE2/G3ZAY/P').matchType, 'exact');
  assert.equal(resolveCallsign(index, 'VE2/G3ZAY/M').entity, 'Canada');
});

test('X/Y tie-breaks: whole-token match wins, then callsign structure, then length', () => {
  assert.equal(resolveCallsign(index, 'VR/DL1ABC').entity, 'Hong Kong');
  assert.equal(resolveCallsign(index, 'DL1ABC/VR').entity, 'Hong Kong');
  assert.equal(resolveCallsign(index, 'KH6/DL1ABC').entity, 'Hawaii');
  assert.equal(resolveCallsign(index, 'DL1ABC/W7').entity, 'United States');
  assert.equal(resolveCallsign(index, 'DL1ABC/W7').precision, 'area');
  assert.equal(resolveCallsign(index, 'W7/DL1ABC').entity, 'United States');
  assert.equal(resolveCallsign(index, '9M0/DL1ABC').entity, 'Spratly Islands');
  assert.equal(resolveCallsign(index, 'ZZ9/DL1ABC').entity, 'Fed. Rep. of Germany', 'unknown designator falls back to the other side');
  assert.equal(resolveCallsign(index, 'ZZ9/ZZ8'), null);
});

test('skimmer suffixes and whitespace are tolerated', () => {
  assert.equal(resolveCallsign(index, 'DL8LAS-#').entity, 'Fed. Rep. of Germany');
  assert.equal(resolveCallsign(index, 'W3LPL-2').entity, 'United States');
  assert.equal(resolveCallsign(index, '  dl1abc ').entity, 'Fed. Rep. of Germany');
});

test('area precision applies only to large entities that have call areas', () => {
  assert.equal(resolveCallsign(index, 'VE3ABC').precision, 'area');
  assert.deepEqual([resolveCallsign(index, 'VE3ABC').lat, resolveCallsign(index, 'VE3ABC').lon], [48, -83]);
  assert.equal(resolveCallsign(index, 'JA1ABC').precision, 'area');
  assert.equal(resolveCallsign(index, 'VK6MB/1').precision, 'area', 'exact entry with a /digit uses that area');
  assert.deepEqual([resolveCallsign(index, 'VK6MB/1').lat, resolveCallsign(index, 'VK6MB/1').lon], [-35.3, 149.1]);
  assert.equal(resolveCallsign(index, 'KH6ABC').precision, 'entity');
  assert.equal(resolveCallsign(index, 'KG4AC').entity, 'Guantanamo Bay');
  assert.equal(resolveCallsign(index, 'KG4AC').precision, 'entity');
  assert.equal(resolveCallsign(index, 'JD1BPS/1').precision, 'entity', 'JD1 is Ogasawara, no mainland area');
  assert.equal(resolveCallsign(index, 'DL1ABC').precision, 'entity');
});

test('result carries the token-level overrides and the corrected utcOffset', () => {
  const r = resolveCallsign(index, 'QB1AA');
  assert.equal(r.entity, 'Synthetic Overrides');
  assert.deepEqual(
    { cq: r.cq, itu: r.itu, continent: r.continent, lat: r.lat, lon: r.lon, utcOffset: r.utcOffset },
    { cq: 38, itu: 70, continent: 'AF', lat: 12.34, lon: 56.78, utcOffset: 3.5 },
  );
  assert.equal(resolveCallsign(index, 'DL1ABC').utcOffset, 1);
  assert.equal(resolveCallsign(index, 'W1AW').utcOffset, -5);
});

// ---------------------------------------------------------------------------
// callAreaCentroid
// ---------------------------------------------------------------------------

test('callAreaCentroid knows US, Canada, Russia, Australia, Japan and Brazil areas', () => {
  assert.deepEqual(callAreaCentroid('W1AW'), { lat: 43.5, lon: -71.5 });
  assert.deepEqual(callAreaCentroid('N2NL'), { lat: 42, lon: -75 });
  assert.deepEqual(callAreaCentroid('AA0XX'), { lat: 42, lon: -97 });
  assert.deepEqual(callAreaCentroid('K6ABC'), { lat: 37, lon: -120 });
  assert.deepEqual(callAreaCentroid('W1AW/7'), { lat: 44, lon: -114 });
  assert.deepEqual(callAreaCentroid('VE7ABC'), { lat: 53, lon: -123 });
  assert.deepEqual(callAreaCentroid('VA3ABC'), { lat: 48, lon: -83 });
  assert.deepEqual(callAreaCentroid('VO1ABC'), { lat: 48.5, lon: -56 });
  assert.deepEqual(callAreaCentroid('VY1ABC'), { lat: 63, lon: -135 });
  assert.deepEqual(callAreaCentroid('VY2ABC'), { lat: 46.3, lon: -63.2 });
  assert.deepEqual(callAreaCentroid('UA1ABC'), { lat: 60, lon: 35 });
  assert.deepEqual(callAreaCentroid('UA2FF'), { lat: 54.7, lon: 20.5 });
  assert.deepEqual(callAreaCentroid('R2AA'), { lat: 55.5, lon: 38 });
  assert.deepEqual(callAreaCentroid('UA9ABC'), { lat: 57, lon: 70 });
  assert.deepEqual(callAreaCentroid('R0CAF'), { lat: 56, lon: 110 });
  assert.deepEqual(callAreaCentroid('VK2ABC'), { lat: -32.5, lon: 147 });
  assert.deepEqual(callAreaCentroid('VK8ABC'), { lat: -19.5, lon: 133.5 });
  assert.deepEqual(callAreaCentroid('JA1ABC'), { lat: 36, lon: 139.5 });
  assert.deepEqual(callAreaCentroid('JH8ABC'), { lat: 43.2, lon: 142.8 });
  assert.deepEqual(callAreaCentroid('7K1ABC'), { lat: 36, lon: 139.5 });
  assert.deepEqual(callAreaCentroid('JA0ABC'), { lat: 37, lon: 138.5 });
  assert.deepEqual(callAreaCentroid('PY2ABC'), { lat: -22.5, lon: -48.5 });
  assert.deepEqual(callAreaCentroid('PP5ABC'), { lat: -26, lon: -50.5 });
  assert.deepEqual(callAreaCentroid('ZZ1ABC'), { lat: -22.5, lon: -43 });
});

test('callAreaCentroid honours a European Russia entity hint only for area digits 8 and 9', () => {
  assert.deepEqual(callAreaCentroid('UA9XO'), { lat: 57, lon: 70 }, 'no hint: plain digit table');
  assert.deepEqual(callAreaCentroid('UA9XO', {}), { lat: 57, lon: 70 });
  assert.deepEqual(callAreaCentroid('UA9XO', null), { lat: 57, lon: 70 }, 'null options never throw');
  assert.deepEqual(callAreaCentroid('UA9XO', { primaryPrefix: 'UA' }), { lat: 59, lon: 55 });
  assert.deepEqual(callAreaCentroid('R9FA', { primaryPrefix: 'UA' }), { lat: 59, lon: 55 });
  assert.deepEqual(callAreaCentroid('R8FF', { primaryPrefix: 'UA' }), { lat: 59, lon: 55 });
  assert.deepEqual(callAreaCentroid('UA9CAB', { primaryPrefix: 'UA9' }), { lat: 57, lon: 70 }, 'Asiatic Russia keeps West Siberia');
  assert.deepEqual(callAreaCentroid('R8CD', { primaryPrefix: 'UA9' }), { lat: 58, lon: 65 });
  assert.deepEqual(callAreaCentroid('UA1ABC', { primaryPrefix: 'UA' }), { lat: 60, lon: 35 }, 'other digits are unaffected');
  assert.deepEqual(callAreaCentroid('R2AA', { primaryPrefix: 'UA' }), { lat: 55.5, lon: 38 });
  assert.deepEqual(callAreaCentroid('UA2FF', { primaryPrefix: 'UA2' }), { lat: 54.7, lon: 20.5 });
  assert.deepEqual(callAreaCentroid('UA9XO/1', { primaryPrefix: 'UA' }), { lat: 60, lon: 35 }, '/digit override wins');
  assert.deepEqual(callAreaCentroid('W9ABC', { primaryPrefix: 'UA' }), { lat: 42, lon: -89 }, 'hint is ignored outside the Russia branch');
  assert.equal(callAreaCentroid('UR9ABC', { primaryPrefix: 'UA' }), null, 'Ukraine has no table');
});

test('callAreaCentroid returns null outside the table and for mobile stations', () => {
  assert.equal(callAreaCentroid('DL1ABC'), null);
  assert.equal(callAreaCentroid('KH6ABC'), null, 'Hawaii');
  assert.equal(callAreaCentroid('KL7ABC'), null, 'Alaska');
  assert.equal(callAreaCentroid('KP4ABC'), null, 'Puerto Rico');
  assert.equal(callAreaCentroid('VK9ABC'), null, 'external territories');
  assert.equal(callAreaCentroid('VK0ABC'), null);
  assert.equal(callAreaCentroid('PY0ABC'), null, 'Fernando de Noronha etc.');
  assert.equal(callAreaCentroid('JD1ABC'), null, 'Ogasawara');
  assert.equal(callAreaCentroid('UR5ABC'), null, 'Ukraine');
  assert.equal(callAreaCentroid('UA5ABC'), null, 'no area 5');
  assert.equal(callAreaCentroid('BY1ABC'), null, 'China has no table');
  assert.equal(callAreaCentroid('N2NL/MM'), null);
  assert.equal(callAreaCentroid('W1AW/AM'), null);
  assert.equal(callAreaCentroid(''), null);
  assert.equal(callAreaCentroid(null), null);
  assert.equal(callAreaCentroid('4U1UN'), null);
});

// ---------------------------------------------------------------------------
// createCtyResolver
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  impl.calls = calls;
  return impl;
}

function okResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-cty-test-'));
  t.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
  return dir;
}

const silentLog = { info() {}, warn() {}, error() {} };

test('createCtyResolver downloads, caches to <cacheDir>/cty.dat and resolves synchronously', async (t) => {
  const dir = await tempDir(t);
  const cacheDir = path.join(dir, 'nested', 'gods-eye-view');
  const fetchImpl = fakeFetch(() => okResponse(COMBINED));
  const nowMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  const resolver = createCtyResolver({ fetchImpl, cacheDir, now: () => nowMs, log: silentLog });
  assert.equal(resolver.resolve('DL1ABC'), null, 'null before ready');
  assert.equal(resolver.status().loaded, false);
  const idx = await resolver.ready();
  assert.ok(idx);
  assert.equal(idx.entities.length, 29);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, DEFAULT_CTY_URL);
  assert.match(fetchImpl.calls[0].options.headers['User-Agent'], /GodsEyeView/);
  assert.equal(fs.existsSync(path.join(cacheDir, 'cty.dat')), true, 'mkdir -p + cache written');
  assert.equal(fs.readFileSync(path.join(cacheDir, 'cty.dat'), 'utf8'), COMBINED);
  assert.equal(resolver.resolve('DL1ABC').entity, 'Fed. Rep. of Germany');
  assert.equal(resolver.resolve('IT9ABC', { allowWae: true }).entity, 'Sicily');
  assert.equal(resolver.resolve('ZZ9ZZZ'), null);
  const status = resolver.status();
  assert.equal(status.ready, true);
  assert.equal(status.loaded, true);
  assert.equal(status.source, 'download');
  assert.equal(status.entities, 29);
  assert.equal(status.lastError, null);
  assert.equal(status.cacheFile, path.join(cacheDir, 'cty.dat'));
  assert.equal(await resolver.ready(), idx, 'ready() is memoized');
  assert.equal(fetchImpl.calls.length, 1);
});

test('createCtyResolver reuses a fresh cache without downloading', async (t) => {
  const cacheDir = await tempDir(t);
  const cacheFile = path.join(cacheDir, 'cty.dat');
  await fsp.writeFile(cacheFile, EXCERPT, 'utf8');
  const writtenAt = Date.UTC(2026, 8, 10);
  await fsp.utimes(cacheFile, writtenAt / 1000, writtenAt / 1000);
  const fetchImpl = fakeFetch(() => { throw new Error('should not be called'); });
  const resolver = createCtyResolver({ fetchImpl, cacheDir, now: () => writtenAt + DAY_MS, log: silentLog });
  const idx = await resolver.ready();
  assert.equal(idx.entities.length, 21);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(resolver.status().source, 'cache');
  assert.equal(resolver.resolve('W1AW/7').precision, 'area');
});

test('createCtyResolver re-downloads when the cache is older than maxAgeMs', async (t) => {
  const cacheDir = await tempDir(t);
  const cacheFile = path.join(cacheDir, 'cty.dat');
  await fsp.writeFile(cacheFile, EXCERPT, 'utf8');
  const writtenAt = Date.UTC(2026, 8, 1);
  await fsp.utimes(cacheFile, writtenAt / 1000, writtenAt / 1000);
  const fetchImpl = fakeFetch(() => okResponse(COMBINED));
  const resolver = createCtyResolver({ fetchImpl, cacheDir, now: () => writtenAt + 8 * DAY_MS, log: silentLog });
  const idx = await resolver.ready();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(idx.entities.length, 29, 'fresh download replaces the stale cache');
  assert.equal(resolver.status().source, 'download');
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), COMBINED);
});

test('createCtyResolver falls back to the stale cache when the download fails', async (t) => {
  const cacheDir = await tempDir(t);
  const cacheFile = path.join(cacheDir, 'cty.dat');
  await fsp.writeFile(cacheFile, EXCERPT, 'utf8');
  const writtenAt = Date.UTC(2026, 8, 1);
  await fsp.utimes(cacheFile, writtenAt / 1000, writtenAt / 1000);
  const warnings = [];
  const log = { info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} };
  const fetchImpl = fakeFetch(() => { throw new Error('ECONNRESET'); });
  const resolver = createCtyResolver({ fetchImpl, cacheDir, now: () => writtenAt + 30 * DAY_MS, log });
  const idx = await resolver.ready();
  assert.ok(idx, 'stale cache is used');
  assert.equal(idx.entities.length, 21);
  const status = resolver.status();
  assert.equal(status.source, 'stale-cache');
  assert.match(status.lastError, /ECONNRESET/);
  assert.equal(status.loaded, true);
  assert.equal(resolver.resolve('DL1ABC').entity, 'Fed. Rep. of Germany');
  assert.ok(warnings.some((w) => /stale cache/.test(w)));
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), EXCERPT, 'failed download does not clobber the cache');
});

test('createCtyResolver treats HTTP errors and empty/garbage bodies as failures', async (t) => {
  const cacheDir = await tempDir(t);
  const cacheFile = path.join(cacheDir, 'cty.dat');
  await fsp.writeFile(cacheFile, EXCERPT, 'utf8');
  const writtenAt = Date.UTC(2026, 8, 1);
  await fsp.utimes(cacheFile, writtenAt / 1000, writtenAt / 1000);
  const now = () => writtenAt + 30 * DAY_MS;
  const r503 = createCtyResolver({ fetchImpl: fakeFetch(() => okResponse('nope', 503)), cacheDir, now, log: silentLog });
  assert.equal((await r503.ready()).entities.length, 21);
  assert.equal(r503.status().source, 'stale-cache');
  assert.match(r503.status().lastError, /503/);
  const rGarbage = createCtyResolver({ fetchImpl: fakeFetch(() => okResponse('<html>maintenance</html>')), cacheDir, now, log: silentLog });
  assert.equal((await rGarbage.ready()).entities.length, 21);
  assert.equal(rGarbage.status().source, 'stale-cache');
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), EXCERPT);
});

test('createCtyResolver resolves null when neither download nor cache works, and never throws', async (t) => {
  const cacheDir = path.join(await tempDir(t), 'missing');
  const fetchImpl = fakeFetch(() => { throw new Error('offline'); });
  const resolver = createCtyResolver({ fetchImpl, cacheDir, now: Date.now, log: silentLog });
  assert.equal(await resolver.ready(), null);
  assert.equal(resolver.resolve('DL1ABC'), null);
  const status = resolver.status();
  assert.equal(status.ready, true);
  assert.equal(status.loaded, false);
  assert.equal(status.entities, 0);
  assert.match(status.lastError, /offline/);
  const noFetch = createCtyResolver({ fetchImpl: null, cacheDir, log: silentLog });
  assert.equal(await noFetch.ready(), null);
  assert.match(noFetch.status().lastError, /fetch/);
});

test('createCtyResolver passes an abort signal and a custom url to fetch', async (t) => {
  const cacheDir = await tempDir(t);
  const fetchImpl = fakeFetch(() => okResponse(EXCERPT));
  const resolver = createCtyResolver({ fetchImpl, cacheDir, url: 'https://hamrig.com/big-cty.dat', log: silentLog });
  await resolver.ready();
  assert.equal(fetchImpl.calls[0].url, 'https://hamrig.com/big-cty.dat');
  assert.ok(fetchImpl.calls[0].options.signal, 'abort signal for the timeout');
  assert.equal(resolver.status().url, 'https://hamrig.com/big-cty.dat');
});
