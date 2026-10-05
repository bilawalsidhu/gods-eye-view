import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createSubject } from './subject.js';
import { createControls } from '../installations/controls.js';
import { createModel } from '../installations/model.js';
import { summarizeAwarenessCohort } from '../../data/militaryAwarenessEngine.js';

test('Contacts excludes square corners and measures from the current moving subject', () => {
  const records = [
    { id: 'corner', kind: 'installation', latitude: 90 / 111.195, longitude: 90 / 111.195 },
    { id: 'east', kind: 'installation', latitude: 0, longitude: 90 / 111.195 },
    { id: 'west', kind: 'installation', latitude: 0, longitude: -90 / 111.195 },
  ];
  const installationState = { records, contextAnchor: { latitude: 0, longitude: 0 },
    lastUpdate: 1, status: 'ready', coverage: { kind: 'subject', radiusM: 100000 },
    distanceEndpointScratch: new Cesium.Cartographic(),
    distanceGeodesicScratch: new Cesium.EllipsoidGeodesic(),
  };
  const installationParts = { rendering: { installationSurfaceHeightM: () => 0 } };
  installationParts.model = createModel({ state: installationState, parts: installationParts });
  const installations = createControls({ state: installationState, parts: installationParts }).methods;
  const services = { installations, flights: { getNearby: () => [] },
    military: { getNearby: () => [] }, vessels: { getNearby: () => [] } };
  const parts = { navigation: { summarizeAwarenessCohortForNavigation: (items, source) =>
    summarizeAwarenessCohort(items, source) } };
  parts.queries = createQueries({ state: {}, services, parts });
  const subjectOwner = createSubject({ state: {}, services, parts });
  const states = Object.fromEntries(['flights', 'military', 'ais-live-vessels', 'military-installations']
    .map((id) => [id, { available: true, stats: {} }]));
  states['military-installations'].stats.coverage = { kind: 'subject', radiusM: 100000 };
  const evaluate = (lon) => subjectOwner.evaluateSubject({
    id: 'moving', layerId: 'flights', position: Cesium.Cartesian3.fromDegrees(lon, 0, 10000),
  }, states).cohorts[3].summary;
  installations.setContextAnchor({ latitude: 0, longitude: 0 });
  const first = evaluate(0);
  assert.equal(first.count, 2);
  assert.ok(!first.nearest.some((item) => item.id === 'corner'), '90 km N + 90 km E is outside the disk');
  assert.equal(installations.getStats().count, 2);
  assert.equal(installations.getStats().statusMessage, '2 mapped sites within 100 km of the contact');
  installations.setContextAnchor({ latitude: 0, longitude: 19 / 111.195 });
  const moved = evaluate(19 / 111.195);
  assert.equal(installations.getStats().count, 1);
  assert.equal(installations.getStats().statusMessage, '1 mapped site within 100 km of the contact');
  assert.equal(moved.count, 1, 'west site leaves the radius before the fetch anchor refreshes');
  assert.equal(moved.nearest[0].id, 'east');
  assert.equal(moved.reason, 'mapped matches within 100 km of the subject');
  assert.deepEqual(installationState.contextAnchor, { latitude: 0, longitude: 0 });
});
