import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_CREDITS } from './dataCredits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const byKey = (key) => DATA_CREDITS.find((credit) => credit.key === key);

test('credit keys are unique and every entry carries html', () => {
  const keys = DATA_CREDITS.map((credit) => credit.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate credit key');
  for (const credit of DATA_CREDITS) {
    assert.equal(typeof credit.html, 'string');
    assert.ok(credit.html.trim().length > 0, `${credit.key} has empty html`);
  }
});

// The SFI / K / A readout comes from N0NBH (hamqsl.com solarxml.php) via HamRig
// /api/propagation/conditions, not from NOAA. hamqsl.com's condition is that the
// credit stays intact, so the entry must exist and link back.
test('N0NBH / hamqsl.com is credited with a link back (source of the SFI/K/A readout)', () => {
  const credit = byKey('n0nbh-hamqsl');
  assert.ok(credit, 'n0nbh-hamqsl credit missing');
  assert.match(credit.html, /N0NBH/);
  assert.match(credit.html, /href="https:\/\/www\.hamqsl\.com\/solar\.html"/);
  assert.match(credit.html, /SFI/);
  // NOAA still applies to aurora / X-ray / solar wind / Bz — it must not have been dropped.
  assert.ok(byKey('noaa-swpc'), 'noaa-swpc credit missing');
});

// GEV calls /api/fm/repeaters/nearby, which serves HamRig's fm_repeaters table only.
// DL3EL's relaislisten.darc.de rows sit behind the authed /api/repeaters/for-location
// route that GEV never calls, so crediting DL3EL here would be a misattribution.
test('repeater credit names only the sources behind the routes GEV calls', () => {
  const credit = byKey('hamrig-repeaters');
  assert.ok(credit, 'hamrig-repeaters credit missing');
  assert.doesNotMatch(credit.html, /DL3EL|relaislisten|explicit permission/i);
  for (const source of ['HamRig FM table', 'hearham.com', 'dstarinfo.com', 'ircddb.net']) {
    assert.ok(credit.html.includes(source), `repeater credit lacks ${source}`);
  }
  // scripts/qa-l9-matrix.mjs CREDIT_EXPECTATIONS['ham-repeaters'] = /repeater database/i
  assert.match(credit.html, /repeater database/i);
});

// dataCredits.js documents that its strings are copied from DATA_SOURCES.md; pin
// the two ham attribution strings so the index and the credit list cannot drift.
test('DATA_SOURCES.md carries the same ham attribution strings and no DL3EL claim', () => {
  const doc = readFileSync(path.join(ROOT, 'DATA_SOURCES.md'), 'utf8');
  assert.ok(doc.includes('"Solar-terrestrial data: N0NBH — hamqsl.com"'));
  assert.ok(doc.includes('"Repeaters: HamRig repeater database (HamRig FM table; hearham.com; dstarinfo.com; ircddb.net)"'));
  assert.ok(doc.includes('`/api/propagation/conditions`'), 'N0NBH row should name the relay route');
  assert.doesNotMatch(doc, /explicit permission granted to HamRig/);
  // The NOAA row must no longer list the N0NBH-backed route as a NOAA relay.
  const noaaRow = doc.split('\n').find((line) => line.startsWith('| **NOAA SWPC**'));
  assert.ok(noaaRow, 'NOAA SWPC row missing');
  assert.doesNotMatch(noaaRow, /propagation\/conditions/);
});
