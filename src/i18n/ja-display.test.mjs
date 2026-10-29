import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from './index.js';
import {
  cockpitUnitCase,
  formatCockpitDistance,
} from '../ui/cockpitPresentation.js';

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
