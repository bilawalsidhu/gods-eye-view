import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createSubject } from './subject.js';
import { createControls } from '../installations/controls.js';
import { createModel } from '../installations/model.js';
import { summarizeAwarenessCohort } from '../../data/militaryAwarenessEngine.js';
import { AWARENESS_QUERY_LIMIT } from './policy.js';

test('aircraft window marks a capped layer as a lower bound', () => {
  const rows = Array.from({ length: AWARENESS_QUERY_LIMIT + 1 }, (_, index) => ({
    icao24: `f${index}`,
    distance: index,
  }));
  let requested = null;
  const services = {
    flights: {
      getNearby: (_position, _radius, limit) => {
        requested = limit;
        return rows.slice(0, limit);
      },
    },
    military: { getNearby: () => [] },
  };
  const parts = {
    navigation: {
      summarizeAwarenessCohortForNavigation: (items, source) =>
        summarizeAwarenessCohort(items, source),
    },
  };
  const queries = createQueries({ state: {}, services, parts });
  const window = queries.collectAircraftProximityWindow({ center: true });
  assert.equal(requested, AWARENESS_QUERY_LIMIT + 2);
  assert.equal(window.flights.length, AWARENESS_QUERY_LIMIT);
  assert.equal(window.aircraft, AWARENESS_QUERY_LIMIT);
  assert.deepEqual(window.completeByLayer, {
    flights: false,
    military: true,
  });
});

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

test('Contacts cohorts carry the provider and whether it answered as a fallback or stale', () => {
  const services = { installations: { getNearby: () => [], getStats: () => ({}) },
    flights: { getNearby: () => [] }, military: { getNearby: () => [] }, vessels: { getNearby: () => [] } };
  const parts = { navigation: { summarizeAwarenessCohortForNavigation: (items, source) =>
    summarizeAwarenessCohort(items, source) } };
  parts.queries = createQueries({ state: {}, services, parts });
  const subjectOwner = createSubject({ state: {}, services, parts });
  const states = {
    // The OpenSky proxy answers from adsb.lol when OpenSky fails.
    flights: { available: true, stats: { source: 'adsb.lol', coverage: '250nm regional fallback', count: 4, lastUpdate: 1 } },
    military: { available: true, stats: { source: 'adsb.lol', fallback: false, count: 2, lastUpdate: 1 } },
    'ais-live-vessels': { available: true, stats: { source: 'Datalastic', stale: true, count: 3, lastUpdate: 1 } },
    'military-installations': { available: true, stats: { coverage: { kind: 'subject', radiusM: 100000 } } },
  };
  const { cohorts } = subjectOwner.evaluateSubject({
    id: 'subject', layerId: 'flights', position: Cesium.Cartesian3.fromDegrees(0, 0, 10000),
  }, states);
  const byId = Object.fromEntries(cohorts.map((cohort) => [cohort.id, cohort]));
  assert.equal(byId.flights.source, 'adsb.lol');
  assert.equal(byId.flights.sourceStatus, 'fallback');
  assert.equal(byId.military.sourceStatus, null);
  assert.equal(byId['ais-live-vessels'].source, 'Datalastic');
  assert.equal(byId['ais-live-vessels'].sourceStatus, 'stale');
  assert.equal(byId['military-installations'].sourceStatus, null);
});
