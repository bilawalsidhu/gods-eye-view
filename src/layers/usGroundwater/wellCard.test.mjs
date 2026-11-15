import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapWellCardLine,
  wellCardColumns,
  wellRecordLabel,
} from './wellCard.js';

test('phone card lines fit a bounded native card without changing source text', () => {
  const width = wellCardColumns(390);
  assert.ok(width <= 49);
  const url =
    'https://www.hydroshare.org/resource/8b02895f02c14dd1a749bcc5584a5c55/';
  const lines = wrapWellCardLine(url, width);
  assert.ok(lines.every((line) => line.length <= width));
  assert.equal(lines.join(''), url);
  assert.equal(wellCardColumns(1440), 68);
  assert.equal(wellCardColumns(undefined), 68);
});

test('native well card wraps coverage and source URLs without losing content', () => {
  const coverage =
    'Historical snapshot; incomplete coverage. Source records have varying positional accuracy and acquisition dates. Empty areas do not establish absence of wells.';
  const lines = wrapWellCardLine(coverage);
  assert.ok(lines.every((line) => line.length <= 68));
  assert.equal(lines.join(' '), coverage);
  const url =
    'https://www.hydroshare.org/resource/8b02895f02c14dd1a749bcc5584a5c55/data/contents/';
  assert.equal(wrapWellCardLine(url, 45).join(''), url);
});

import { wellDisplayName } from './wellCard.js';
test('display names use the neutral source identity without changing the record', () => {
  const record = {
    source: 'USGWD',
    id: 'original-id',
    metadata: { sourceRecordId: 'NY0131510' },
  };
  const before = JSON.stringify(record);
  assert.equal(wellDisplayName(record), 'USGWD NY0131510');
  assert.equal(wellRecordLabel(record), 'USGWD NY0131510');
  assert.equal(JSON.stringify(record), before);
});

import { historicalWellCardLines } from './wellCard.js';
test('citizen card puts available construction and reported capacity facts before provenance', () => {
  const record = {
    id: 'original',
    metadata: {
      sourceRecordId: 'CA0981325',
      quantities: {
        'Well Depth (Feet)': { value: 260, unit: 'ft', quality: 'valid' },
        'Well Capacity (GPM)': { value: 15, unit: 'gal/min', quality: 'valid' },
        'Screen Depth (Feet)': { value: 220, unit: 'ft', quality: 'valid' },
        'Length of Screen (Feet)': { value: 40, unit: 'ft', quality: 'valid' },
      },
      sourceYears: {
        'Year Well was Constructed': { year: '2015', precision: 'year' },
        'Year Reported': { year: '2017', precision: 'year' },
      },
    },
  };
  assert.deepEqual(historicalWellCardLines(record), [
    'Well depth: 260 ft',
    'Reported capacity: 15 gal/min',
    'Screen depth: 220 ft',
    'Screen length: 40 ft',
    'Constructed: 2015',
    'Reported: 2017',
    'Historical source record; not current performance.',
    'Source: USGWD CA0981325',
  ]);
});
test('citizen card omits missing/invalid/unit-mismatched facts and never invents water level or dates', () => {
  const record = {
    id: 'original',
    metadata: {
      quantities: {
        'Well Depth (Feet)': { value: null, unit: 'ft', quality: 'missing' },
        'Well Capacity (GPM)': { value: 0, unit: 'gal/min', quality: 'valid' },
        'Screen Depth (Feet)': { value: 42, unit: 'm', quality: 'valid' },
        'Length of Screen (Feet)': {
          value: -2,
          unit: 'ft',
          quality: 'invalid',
        },
      },
      sourceYears: { 'Year Well was Constructed': null },
    },
  };
  const lines = historicalWellCardLines(record);
  assert.equal(lines[0], 'Reported capacity: 0 gal/min');
  assert.doesNotMatch(
    lines.join(' '),
    /water level|Constructed|Screen|Unknown/,
  );
  assert.equal(
    historicalWellCardLines({ id: 'x' })[0],
    'No usable size or capacity details available.',
  );
});

test('unusable source quantities are not described as absent and year-only records avoid missing-value filler', () => {
  const record = {
    id: 'x',
    metadata: {
      quantities: {
        'Well Depth (Feet)': { quality: 'invalid', value: null, unit: 'ft' },
      },
      quantityErrors: [{ field: 'Well Depth (Feet)', rawValue: 'bad' }],
    },
  };
  assert.equal(
    historicalWellCardLines(record)[0],
    'No usable size or capacity details available.',
  );
  record.metadata.sourceYears = {
    'Year Reported': { year: '2011', precision: 'year' },
  };
  assert.equal(historicalWellCardLines(record)[0], 'Reported: 2011');
});
