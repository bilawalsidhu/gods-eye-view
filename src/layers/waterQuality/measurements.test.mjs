import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANALYTE_LABEL_MAX,
  alignedValueLines,
  analyteLabel,
  cardBodyLines,
  displayUnit,
  latestPerAnalyte,
} from './measurements.js';

const detected = (characteristic, value, unit, sampledAt = '2024-01-01') => ({
  characteristic,
  value,
  unit,
  sampledAt,
  detected: true,
});
const missing = (characteristic, detectionLimit, unit) => ({
  characteristic,
  value: null,
  unit,
  detectionLimit,
  sampledAt: '2024-01-01',
  detected: false,
});

test('a repeatedly sampled analyte collapses to its most recent row', () => {
  // Six card lines must mean six substances, not one substance six times.
  const collapsed = latestPerAnalyte([
    detected('Nitrogen', 1.7, 'mg/l', '2021-10-20'),
    detected('Nitrogen', 0.9, 'mg/l', '2019-04-02'),
    detected('Phosphorus', 0.05, 'mg/l', '2023-08-14'),
  ]);
  assert.equal(collapsed.length, 2);
  assert.equal(
    collapsed.find((m) => m.characteristic === 'Nitrogen').value,
    1.7,
  );
});

test('unusable rows never become a blank analyte', () => {
  assert.deepEqual(latestPerAnalyte(null), []);
  assert.deepEqual(latestPerAnalyte([{ characteristic: '   ' }]), []);
});

test('unreadable portal names use their standard short form, others elide', () => {
  assert.equal(
    analyteLabel('Nitrogen, mixed forms (NH3), (NH4), organic, (NO2) and (NO3)'),
    'TOTAL NITROGEN',
  );
  assert.equal(analyteLabel('Escherichia coli'), 'E. COLI');
  // Not in the alias table: elided, never renamed into a different claim.
  const long = analyteLabel('Perfluorooctanesulfonamidoacetic acid, N-methyl');
  assert.equal(long.length, ANALYTE_LABEL_MAX);
  assert.ok(long.endsWith('…'));
  assert.equal(analyteLabel('Phosphorus'), 'PHOSPHORUS');
});

test('only the litre symbol and micro prefix are normalized', () => {
  assert.equal(displayUnit('mg/l'), 'mg/L');
  assert.equal(displayUnit('ug/l'), 'µg/L');
  // "as N" changes what the number means and must survive untouched.
  assert.equal(displayUnit('mg/l as N'), 'mg/L as N');
  assert.equal(displayUnit(null), '');
});

test('values line up in a column so concentrations can be scanned', () => {
  const lines = alignedValueLines([
    detected('Nitrate', 1.63, 'mg/l as N'),
    detected('Phosphorus', 0.05, 'mg/l'),
  ]);
  const valueColumn = lines.map((line) => line.indexOf('1.63'));
  assert.equal(lines[0], 'NITRATE     1.63 mg/L as N');
  assert.equal(lines[1], 'PHOSPHORUS  0.05 mg/L');
  // Both numbers start at the same column.
  assert.equal(lines[0].indexOf('1.63'), lines[1].indexOf('0.05'));
  assert.ok(valueColumn[0] > 0);
});

test('detections lead and non-detects collapse into one counted line', () => {
  const lines = cardBodyLines(
    [
      detected('Nitrate', 1.63, 'mg/l as N'),
      missing('Nitrite', 0.001, 'mg/l as N'),
      missing('Organic nitrogen', 0.07, 'mg/l'),
      missing('Ammonia and ammonium', 0.02, 'mg/l as N'),
    ],
    6,
  );
  assert.equal(lines[0], 'NITRATE  1.63 mg/L as N');
  assert.equal(lines[1], '3 further analytes not detected');
  assert.equal(lines.length, 2);
});

test('a site with nothing detected says so instead of listing blanks', () => {
  const lines = cardBodyLines(
    [missing('Nitrite', 0.001, 'mg/l'), missing('Organic nitrogen', 0.07, 'mg/l')],
    6,
  );
  assert.deepEqual(lines, ['No detections across 2 analytes']);
});

test('detected analytes past the limit are counted, not dropped silently', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    detected(`Analyte ${i}`, i, 'mg/l'),
  );
  const lines = cardBodyLines(many, 6);
  assert.equal(lines.length, 7);
  assert.equal(lines[6], '+3 more detected');
});

test('an empty result set is distinguishable from an unsampled site', () => {
  assert.deepEqual(cardBodyLines([], 6), ['No results in window']);
});
