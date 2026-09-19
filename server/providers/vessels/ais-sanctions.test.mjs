import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSdnVessels,
  buildSanctionsIndex,
  screenAgainstIndex,
  sanctionsEnabled,
  createSanctionsScreening,
} from './ais-sanctions.js';

// Shape mirrors the real SDN CSV: positional, quoted remarks, "-0-" for null.
const SDN_FIXTURE = [
  '1,"EBANO","vessel","CUBA","-0-","CL2192","Cargo","1000","2000","Panama","SOME OWNER","Vessel Registration Identification IMO 7406784."',
  '2,"SOME PERSON","individual","IRAN","-0-","-0-","-0-","-0-","-0-","-0-","-0-","DOB 1 Jan 1970"',
  '3,"DARK TANKER","vessel","IRAN-EO13846","-0-","9HA1234","Crude Oil Tanker","50000","90000","Malta","OWNER LTD","Identification IMO 9409065; Former name X."',
  '4,"NO IMO SHIP","vessel","CUBA","-0-","-0-","Cargo","-0-","-0-","Cuba","-0-","No identifiers on file."',
].join('\n');

test('parses only vessel rows, recovering IMO from remarks', () => {
  const vessels = parseSdnVessels(SDN_FIXTURE);
  assert.equal(vessels.length, 3, 'the individual is skipped');
  assert.equal(vessels[0].name, 'EBANO');
  assert.equal(vessels[0].imo, '7406784');
  assert.equal(vessels[0].flag, 'Panama');
  assert.equal(vessels[1].imo, '9409065');
  assert.equal(vessels[2].imo, '', 'no IMO in remarks stays empty');
});

test('"-0-" placeholders normalize to empty strings', () => {
  const vessels = parseSdnVessels(SDN_FIXTURE);
  assert.equal(vessels[2].callSign, '');
  assert.equal(vessels[2].owner, '');
});

test('an IMO match is reported with IMO confidence', () => {
  const index = buildSanctionsIndex(parseSdnVessels(SDN_FIXTURE));
  const result = screenAgainstIndex(index, { imo: '9409065' });
  assert.equal(result.listed, true);
  assert.equal(result.confidence, 'IMO');
  assert.equal(result.matches[0].name, 'DARK TANKER');
  assert.equal(result.matches[0].program, 'IRAN-EO13846');
});

test('an invalid IMO is not used as a lookup key', () => {
  const index = buildSanctionsIndex(parseSdnVessels(SDN_FIXTURE));
  // 9409066 fails the check digit; it must not match 9409065's neighbour slot.
  assert.equal(screenAgainstIndex(index, { imo: '9409066' }).listed, false);
});

test('a call sign match is identity-grade and counts as listed', () => {
  const index = buildSanctionsIndex(parseSdnVessels(SDN_FIXTURE));
  const result = screenAgainstIndex(index, { callSign: '9ha1234' });
  assert.equal(result.confidence, 'CALLSIGN');
  assert.equal(result.listed, true);
});

test('a name-only match is surfaced but is never a verdict', () => {
  const index = buildSanctionsIndex(parseSdnVessels(SDN_FIXTURE));
  const result = screenAgainstIndex(index, { name: 'dark  tanker' });
  assert.equal(result.confidence, 'NAME');
  assert.equal(result.listed, false, 'shared ship names are not identifiers');
  assert.equal(result.possibleNameMatch, true);
  assert.equal(result.matches[0].name, 'DARK TANKER');
});

test('short names and call signs never match, to bound false positives', () => {
  const index = buildSanctionsIndex(parseSdnVessels(SDN_FIXTURE));
  assert.equal(screenAgainstIndex(index, { name: 'AL' }).listed, false);
  assert.equal(screenAgainstIndex(index, { callSign: 'AB' }).listed, false);
});

test('a clean vessel returns a negative verdict', () => {
  const index = buildSanctionsIndex(parseSdnVessels(SDN_FIXTURE));
  const result = screenAgainstIndex(index, {
    imo: '9074729', name: 'CAPE BRITANNIA', callSign: '7JYW',
  });
  assert.deepEqual(result, {
    listed: false, confidence: null, matches: [], possibleNameMatch: false,
  });
});

test('screening with no index loaded is inert', () => {
  assert.deepEqual(screenAgainstIndex(null, { imo: '9409065' }), {
    listed: false, confidence: null, matches: [], possibleNameMatch: false,
  });
});

test('GEV_SANCTIONS opt-out is respected, default is on', () => {
  assert.equal(sanctionsEnabled({}), true);
  assert.equal(sanctionsEnabled({ GEV_SANCTIONS: '0' }), false);
  assert.equal(sanctionsEnabled({ GEV_SANCTIONS: 'off' }), false);
  assert.equal(sanctionsEnabled({ GEV_SANCTIONS: '1' }), true);
});

test('an unreachable list leaves screening negative rather than throwing', async () => {
  const service = createSanctionsScreening({
    cachePath: '/nonexistent/dir/sdn.csv',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  await service.refresh();
  assert.equal(service.status().error, 'network down');
  assert.deepEqual(service.screen({ imo: '9409065' }).listed, false);
});

test('a non-OK HTTP response does not replace a good index', async () => {
  const service = createSanctionsScreening({
    cachePath: '/nonexistent/dir/sdn.csv',
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
  });
  await service.refresh();
  assert.match(service.status().error, /503/);
  assert.equal(service.status().ready, false);
});
