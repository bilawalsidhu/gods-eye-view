import assert from 'node:assert/strict';
import test from 'node:test';

import * as fleet from './index.js';
import * as fleetModels from '../data/fleetModels.js';
import * as policy from '../layers/flights/policy.js';
import * as partDrivers from '../data/modelPartDrivers.js';
import * as vesselSprites from '../data/vesselSprites.js';

test('hands out the layers’ own functions and constants, not copies', () => {
  assert.equal(fleet.loadFleetModelSet, fleetModels.loadFleetModelSet);
  assert.equal(fleet.fleetModelSet, fleetModels.fleetModelSet);
  assert.equal(fleet.resolveAircraft, fleetModels.resolveAircraft);
  assert.equal(fleet.resolveVessel, fleetModels.resolveVessel);
  assert.equal(fleet.FLEET_MODEL_POLICY, policy.FLEET_MODEL_POLICY);
  assert.equal(fleet.MODEL_WHITE, policy.MODEL_WHITE);
  assert.equal(fleet.vesselPartState, partDrivers.vesselPartState);
  assert.equal(fleet.vesselSprite, vesselSprites.vesselSprite);
});

test('the handover is the aircraft layers’ distances, the policy every fleet layer takes', () => {
  assert.equal(fleet.FLEET_MODEL_POLICY.addM, fleet.MODEL_ADD_M);
  assert.equal(fleet.FLEET_MODEL_POLICY.keepM, fleet.MODEL_KEEP_M);
  assert.equal(
    fleet.FLEET_MODEL_POLICY.altitudeCeilingM,
    fleet.MODEL_ALT_CEIL_M,
  );
  assert.ok(fleet.MODEL_KEEP_M > fleet.MODEL_ADD_M);
});

test('a vessel kind’s hull sprite is an SVG data URI, the same each time', () => {
  const hull = fleet.vesselSprite(fleet.vesselKind('70'));
  assert.match(hull, /^data:image\/svg\+xml;base64,/);
  assert.equal(fleet.vesselSprite('cargo'), hull);
  assert.notEqual(fleet.aidSprite(), hull);
});
