import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from './index.js';
import {
  cockpitUnitCase,
  formatCockpitDistance,
} from '../ui/cockpitPresentation.js';
import { LOCALIZED_LOCALITY } from '../hudLocalityFormat.js';

test('Japanese cockpit distances keep the unit in its own case', () => {
  try {
    setLocale('ja');
    assert.equal(formatCockpitDistance(14000), '14 km');
    assert.equal(formatCockpitDistance(9500), '9.5 km');
    assert.equal(cockpitUnitCase('km'), 'km');
    setLocale('en');
    assert.equal(formatCockpitDistance(14000), '14 KM');
    assert.equal(cockpitUnitCase('km'), 'KM');
  } finally {
    setLocale('en');
  }
});

test('Japanese near-locality keeps the unit case', () => {
  try {
    setLocale('ja');
    assert.equal(
      LOCALIZED_LOCALITY.near({ poi: 'Shibuya', city: 'Tokyo', distKm: 13 }),
      'SHIBUYA（東京）付近 13 km',
    );
  } finally {
    setLocale('en');
  }
});
