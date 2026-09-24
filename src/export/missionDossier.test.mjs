import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMarkdownDossier } from './missionDossier.js';

test('generateMarkdownDossier compiles structured intel document with all sections', () => {
  const md = generateMarkdownDossier({
    operationName: 'OPERATION NIGHTWATCH',
    classification: 'TOP SECRET',
    timestamp: new Date('2026-09-20T12:00:00Z'),
    cameraState: {
      latDeg: 35.6895,
      lonDeg: 139.6917,
      altitudeM: 15000,
      headingDeg: 180,
      pitchDeg: -45,
    },
    trackedEntity: {
      id: 'SKY-VIPER-1',
      type: 'AIRCRAFT',
      speedKts: 480,
      altitudeM: 10200,
      headingDeg: 175,
      latDeg: 35.5,
      lonDeg: 139.7,
    },
    geofences: [
      {
        id: 'z1',
        name: 'Tokyo Airspace',
        type: 'circle',
        radiusM: 50000,
        alertLevel: 'critical',
      },
    ],
    weather: {
      available: true,
      cloud: 0.8,
      rain: 0.5,
      wind: 0.3,
      windDirectionDeg: 90,
      storm: 0.1,
    },
  });

  assert.ok(md.includes('# 🛰️ OPERATION NIGHTWATCH'));
  assert.ok(md.includes('2026-09-20 12:00:00Z'));
  assert.ok(md.includes('35.68950°'));
  assert.ok(md.includes('SKY-VIPER-1'));
  assert.ok(md.includes('480 kts'));
  assert.ok(md.includes('Tokyo Airspace'));
  assert.ok(md.includes('Rain'));
});
