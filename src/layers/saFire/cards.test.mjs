import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INCIDENT_STATUS_BANDS,
  buildIncidentCard,
  buildWarningCard,
  formatAdelaideDateTime,
  formatAdelaideTime,
  incidentLevelRank,
  incidentStatusBand,
  incidentStatusColor,
  warningCategoryColor,
  wrapCardText,
} from './cards.js';

const row = {
  id: 'F2610120119',
  agency: 'CFS',
  name: 'MOUNT COMPASS',
  lat: -35.354339,
  lon: 138.626986,
  region: 'R1',
  fireBanDistrict: 'MOUNT LOFTY RANGES',
  type: 'BURN OFF',
  status: 'Going',
  level: 'L2',
  ground: 3,
  aircraft: 1,
  messageCount: 1,
  reportedTime: Date.UTC(2026, 9, 12, 9, 0), // 12 Oct 19:30 ACDT
};

test('status colours: Going red-orange, Contained amber, Controlled yellow, Safe green, else grey', () => {
  const colours = ['Going', 'Contained', 'Controlled', 'Safe'].map(
    incidentStatusColor,
  );
  assert.equal(new Set(colours).size, 4);
  for (const colour of colours) assert.match(colour, /^#[0-9a-f]{6}$/);
  assert.equal(incidentStatusColor('going'), incidentStatusColor('GOING'));
  assert.equal(incidentStatusColor(' Safe '), incidentStatusColor('Safe'));
  const grey = incidentStatusColor('Under Investigation');
  for (const unknown of [null, undefined, '', 7, {}, 'Goin'])
    assert.equal(incidentStatusColor(unknown), grey);
  assert.ok(!colours.includes(grey));
});

test('status bands cover every status once and unknown values fall into "Other"', () => {
  assert.equal(incidentStatusBand('going'), 'Going');
  assert.equal(incidentStatusBand('Safe'), 'Safe');
  assert.equal(incidentStatusBand('Responding'), 'Other / unknown');
  assert.equal(incidentStatusBand(null), 'Other / unknown');
  assert.equal(
    new Set(INCIDENT_STATUS_BANDS.map((band) => band.label)).size,
    INCIDENT_STATUS_BANDS.length,
  );
});

test('level rank sizes markers L1 < L2 < L3 and defaults unknown levels to the smallest', () => {
  assert.deepEqual(
    ['L1', 'L2', 'L3', 'l3'].map(incidentLevelRank),
    [1, 2, 3, 3],
  );
  for (const level of [null, undefined, '', 'L4', 'L0', 'high', 3])
    assert.equal(incidentLevelRank(level), 1);
});

test('warning colours follow the Australian Warning System categories', () => {
  assert.notEqual(
    warningCategoryColor('Emergency Warning'),
    warningCategoryColor('Watch and Act'),
  );
  assert.notEqual(
    warningCategoryColor('Watch and Act'),
    warningCategoryColor('Bushfire Advice'),
  );
  assert.equal(
    warningCategoryColor('Bushfire Advice'),
    warningCategoryColor('Advice'),
  );
  assert.equal(warningCategoryColor('Unknown'), warningCategoryColor(null));
});

test('times display in Adelaide local time with the right zone abbreviation', () => {
  const summer = Date.UTC(2026, 9, 12, 9, 0);
  assert.equal(formatAdelaideTime(summer), '19:30 ACDT');
  assert.equal(formatAdelaideDateTime(summer), '12 Oct 19:30 ACDT');
  const winter = Date.UTC(2026, 7, 27, 11, 48);
  assert.equal(formatAdelaideDateTime(winter), '27 Aug 21:18 ACST');
  // Either side of the 2026-10-04 spring transition (16:30Z).
  assert.equal(formatAdelaideTime(Date.UTC(2026, 9, 3, 16, 29)), '01:59 ACST');
  assert.equal(formatAdelaideTime(Date.UTC(2026, 9, 3, 16, 30)), '03:00 ACDT');
  // Midnight rollover into the next Adelaide day.
  assert.equal(
    formatAdelaideDateTime(Date.UTC(2026, 9, 12, 14, 0)),
    '13 Oct 00:30 ACDT',
  );
  for (const bad of [null, undefined, NaN, 'x'])
    assert.equal(formatAdelaideTime(bad), null);
});

test('the incident card carries every required fact and the visible feed time', () => {
  const feedTime = Date.UTC(2026, 9, 13, 3, 5); // 13 Oct 13:35 ACDT
  const card = buildIncidentCard(row, { feedTime });
  assert.equal(card.id, 'sa-fire-incident-card:F2610120119');
  assert.equal(card.title, 'Burn Off · Mount Compass');
  assert.deepEqual(card.details, [
    'Going · L2 · CFS',
    'Mount Lofty Ranges · Region R1',
    'Reported 12 Oct 19:30 ACDT',
    '3 ground · 1 aircraft · 1 message',
    'Feed updated 13:35 ACDT',
  ]);
  assert.equal(card.accent, incidentStatusColor('Going'));
  assert.equal(card.selected, true);
  assert.equal(card.interactive, false);
});

test('an incident with gaps still builds a sensible card', () => {
  const card = buildIncidentCard({
    id: 'X1',
    agency: 'Forestry SA',
    name: null,
    lat: -34,
    lon: 138,
    region: null,
    fireBanDistrict: null,
    type: null,
    status: null,
    level: null,
    ground: null,
    aircraft: null,
    messageCount: null,
    reportedTime: null,
  });
  assert.equal(card.title, 'Incident · X1');
  assert.deepEqual(card.details, ['Forestry SA', 'Reported time unknown']);
  assert.equal(card.accent, incidentStatusColor(null));
});

const warning = {
  id: 'g:7',
  kind: 'polygon',
  category: 'Watch and Act',
  headline: 'Bushfire - Mount Compass',
  name: 'Mount Compass',
  description: 'A bushfire is burning. '.repeat(30),
  longDescription: null,
  expiryTime: Date.UTC(2026, 9, 13, 5, 0),
  createdTime: Date.UTC(2026, 9, 13, 2, 0),
  editedTime: Date.UTC(2026, 9, 13, 3, 0),
  incidentRef: null,
  mfsIncidentRef: null,
  link: 'https://www.cfs.sa.gov.au/example',
  lat: -35.4,
  lon: 138.7,
};

test('the warning card wraps long untrusted text and offers a link only when one is valid', () => {
  const card = buildWarningCard(warning, {
    feedTime: Date.UTC(2026, 9, 13, 3, 5),
  });
  assert.equal(card.title, 'Watch and Act · Bushfire - Mount Compass');
  assert.equal(card.interactive, true);
  assert.match(card.accessibilityLabel, /cfs\.sa\.gov\.au/);
  for (const line of card.details) assert.ok(line.length <= 60, line);
  assert.ok(card.details.includes('Expires 13 Oct 15:30 ACDT'));
  assert.ok(card.details.includes('Updated 13 Oct 13:30 ACDT'));
  assert.ok(card.details.includes('Feed updated 13:35 ACDT'));
  assert.ok(card.details.at(-1).startsWith('More information'));
  assert.ok(
    card.details.some((line) => line.endsWith('…')),
    'long text is cut',
  );

  const plain = buildWarningCard({ ...warning, link: null, expiryTime: null });
  assert.equal(plain.interactive, false);
  assert.equal(plain.accessibilityLabel, undefined);
  assert.ok(plain.details.includes('No expiry set'));
  assert.ok(!plain.details.some((line) => line.includes('More information')));
});

test('hostile text is only ever carried as plain strings and incident links are named', () => {
  const card = buildWarningCard(
    {
      ...warning,
      headline: '<script>alert(1)</script>'.repeat(10),
      description: '<img src=x onerror=alert(1)>',
    },
    { incident: { id: 'F1', name: 'MOUNT COMPASS' } },
  );
  assert.ok(card.title.length <= 48);
  assert.ok(card.details.every((line) => typeof line === 'string'));
  assert.ok(card.details.includes('<img src=x onerror=alert(1)>'));
  assert.ok(card.details.includes('Incident F1 · Mount Compass'));
});

test('wrapCardText bounds line count and width, including unbroken tokens', () => {
  assert.deepEqual(wrapCardText('one two three', 9, 4), ['one two', 'three']);
  assert.deepEqual(wrapCardText('', 10, 3), []);
  assert.deepEqual(wrapCardText(null), []);
  const lines = wrapCardText('x'.repeat(500) + ' ' + 'y '.repeat(200), 20, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.length <= 20));
  assert.ok(lines[0].endsWith('…'));
});
