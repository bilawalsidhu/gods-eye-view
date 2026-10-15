import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CBSA_OFFICE_CROSSINGS,
  attachCanadaBound,
  parseCbsaCsv,
  parseCbsaFlow,
} from './canada.js';
import { BORDER_CROSSING_LOCATIONS } from './crossings.js';

const HEADER =
  '﻿Customs Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Commercial Flow - U.S. bound;; Travellers Flow - Canada bound;; Travellers Flow - U.S. bound;;';

test('CBSA flow values read as waits, closures or nothing reported', () => {
  assert.deepEqual(parseCbsaFlow('No Delay'), {
    status: 'no delay',
    delayMinutes: 0,
  });
  assert.deepEqual(parseCbsaFlow(' 1 minute '), {
    status: 'delay',
    delayMinutes: 1,
  });
  assert.deepEqual(parseCbsaFlow('45 minutes'), {
    status: 'delay',
    delayMinutes: 45,
  });
  assert.deepEqual(parseCbsaFlow('Closed'), {
    status: 'closed',
    delayMinutes: null,
  });
  for (const value of ['Not Applicable', '--', '', undefined, '99999 minutes'])
    assert.equal(parseCbsaFlow(value), null, String(value));
});

test("CBSA's CSV parses by header name, with a BOM and CRLF line ends", () => {
  const csv = [
    HEADER,
    'Ambassador Bridge;; Windsor, ON/Detroit, MI;; 2026-10-13 11:18 EDT;; 5 minutes;; --;; No Delay;; --;; ',
    'Blue Water Bridge;; Point Edward, ON/Port Huron, MI;; 2026-10-13 11:00 EDT;; Not Applicable;; --;; Closed;; --;; ',
    'Hemmingford;; Hemmingford, QC/Mooers, NY;; 2026-10-13 11:00 EDT;; No Delay;; --;; No Delay;; --;; ',
    ';; ;; ;; ;; ;; ;; ;; ',
  ].join('\r\n');
  const { byCrossing, unmatched } = parseCbsaCsv(csv);
  assert.deepEqual(Object.keys(byCrossing).sort(), ['380001', '380201']);
  assert.deepEqual(byCrossing['380201'], {
    office: 'Blue Water Bridge',
    travellers: { status: 'closed', delayMinutes: null },
    commercial: null,
    updated: '2026-10-13 11:00 EDT',
  });
  assert.deepEqual(unmatched, ['Hemmingford']);
});

test('a changed or foreign CSV is refused rather than read as no waits', () => {
  for (const csv of [
    null,
    '',
    '<html>maintenance</html>',
    'Customs Office;; Location;; Last updated',
  ])
    assert.equal(parseCbsaCsv(csv), null, String(csv));
});

test('every CBSA office maps to a distinct, placed CBP crossing', () => {
  const ids = Object.values(CBSA_OFFICE_CROSSINGS);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids)
    assert.ok(Object.hasOwn(BORDER_CROSSING_LOCATIONS, id), id);
});

test('rows gain their Canada-bound waits, or null', () => {
  const rows = attachCanadaBound([{ id: '380001' }, { id: '250401' }], {
    380001: { office: 'Ambassador Bridge' },
  });
  assert.deepEqual(rows, [
    { id: '380001', canada: { office: 'Ambassador Bridge' } },
    { id: '250401', canada: null },
  ]);
});
