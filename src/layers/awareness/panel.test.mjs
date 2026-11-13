import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanel } from './panel.js';
import { createSubject } from './subject.js';

test('a Contacts row names its provider as the Layers panel does, with its feed state', () => {
  const cohort = (id, source, sourceStatus) => ({
    id,
    label: id,
    source,
    sourceStatus,
    summary: { relationship: 'OBSERVED', count: 1, nearest: [], reason: 'observed' },
  });
  const state = {
    enabled: true,
    results: {
      subject: { label: 'AFR38JF' },
      cohorts: [
        cohort('flights', 'adsb.lol', 'fallback'),
        cohort('military', 'adsb.lol', null),
        cohort('ais-live-vessels', 'Datalastic', 'stale'),
      ],
    },
    cohortPages: new Map(),
    panelListeners: new Set(),
    panelSignature: '',
    navigationIndex: 0,
  };
  const parts = {
    navigation: { canNavigateNext: () => false },
    rendering: { hideDirectionOverlay() {} },
  };
  createPanel({ state, parts }).renderResults();
  assert.deepEqual(
    state.panelView.rows.map((row) => row.detail),
    ['adsb.lol · FALLBACK · observed', 'adsb.lol · observed', 'Datalastic · STALE · observed'],
  );
  state.offPanelLocale?.();
});

const PHOTO = Object.freeze({
  src: 'https://t.plnspttrs.net/1/abc123_280.jpg',
  width: 280,
  height: 186,
  photographer: 'Jane Doe',
  link: 'https://www.planespotters.net/photo/1/n123ab',
});

/** The published Contacts view for one subject and the refresh's photo. */
function photoView(subject, subjectPhoto) {
  const state = {
    enabled: true,
    results: { subject, cohorts: [] },
    subjectPhoto,
    cohortPages: new Map(),
    panelListeners: new Set(),
    panelSignature: '',
    navigationIndex: 0,
  };
  const parts = {
    navigation: { canNavigateNext: () => false },
    rendering: { hideDirectionOverlay() {} },
  };
  createPanel({ state, parts }).renderResults();
  state.offPanelLocale?.();
  return state.panelView;
}

const FLIGHT = Object.freeze({
  layerId: 'flights',
  id: 'abc123',
  label: 'N123AB',
});

test('the Contacts view carries the tracked flight’s photo with its credit', () => {
  const view = photoView(FLIGHT, {
    layerId: 'flights',
    id: 'abc123',
    photo: PHOTO,
  });
  assert.deepEqual(view.photo, {
    src: PHOTO.src,
    width: 280,
    height: 186,
    link: PHOTO.link,
    credit: 'Photo © Jane Doe',
  });
});

test('the Contacts view shows an uncredited photo with no credit line', () => {
  const view = photoView(FLIGHT, {
    layerId: 'flights',
    id: 'abc123',
    photo: { ...PHOTO, photographer: '' },
  });
  assert.equal(view.photo.src, PHOTO.src);
  assert.equal(view.photo.link, PHOTO.link);
  assert.equal(view.photo.credit, '');
});

test('the Contacts view has no photo without one, or with another subject’s', () => {
  assert.equal(photoView(FLIGHT, null).photo, null);
  assert.equal(
    photoView(FLIGHT, { layerId: 'flights', id: 'def456', photo: PHOTO }).photo,
    null,
  );
  assert.equal(
    photoView(
      { layerId: 'ais-live-vessels', id: 'abc123', label: 'VESSEL' },
      { layerId: 'flights', id: 'abc123', photo: PHOTO },
    ).photo,
    null,
  );
});

test('the selected vessel shows its own photo, by its id', () => {
  const asked = [];
  const { resolveSubjectPhoto, subjectFromContext } = createSubject({
    state: {},
    services: {
      flights: {},
      military: {},
      vessels: {
        getVesselPhoto: (id) => {
          asked.push(id);
          return id === 'uuid-1' ? PHOTO : null;
        },
      },
      installations: {},
    },
    parts: { navigation: { isFlightLayer: () => false } },
  });
  assert.deepEqual(
    resolveSubjectPhoto({ layerId: 'ais-live-vessels', id: 'uuid-1' }),
    PHOTO,
  );
  assert.equal(
    resolveSubjectPhoto({ layerId: 'ais-live-vessels', id: 'uuid-2' }),
    null,
  );
  assert.deepEqual(asked, ['uuid-1', 'uuid-2']);
  const vessel = (label, mmsi) =>
    subjectFromContext({
      layerId: 'ais-live-vessels',
      id: 'ais-uuid-1',
      label,
      latitude: 38.3,
      longitude: -123.05,
      properties: { vesselId: 'uuid-1', mmsi },
    });
  assert.equal(
    vessel('USCGC SOCKEYE', '366999709').label,
    'USCGC SOCKEYE · MMSI 366999709',
  );
  assert.equal(vessel('USCGC SOCKEYE', '366999709').id, 'uuid-1');
  // A vessel named by its MMSI, or without one, is not given it twice.
  assert.equal(vessel('MMSI 366999709', '366999709').label, 'MMSI 366999709');
  assert.equal(vessel('USCGC SOCKEYE', null).label, 'USCGC SOCKEYE');
});

test('only the tracked flight has a flight photo: not an installation, a military aircraft or another flight', () => {
  const tracked = {
    layerId: 'flights',
    id: 'abc123',
    label: 'N123AB',
    photo: PHOTO,
  };
  let current = tracked;
  let lookups = 0;
  const flights = {
    getTrackedSubject: () => {
      lookups += 1;
      return current;
    },
  };
  const military = {
    getTrackedSubject: () => ({ ...tracked, layerId: 'military' }),
  };
  const { resolveSubjectPhoto } = createSubject({
    state: {},
    services: { flights, military, vessels: {}, installations: {} },
    parts: {
      navigation: {
        isFlightLayer: (id) => id === 'flights' || id === 'military',
      },
    },
  });
  assert.deepEqual(
    resolveSubjectPhoto({ layerId: 'flights', id: 'abc123' }),
    PHOTO,
  );
  assert.equal(lookups, 1);
  assert.equal(resolveSubjectPhoto({ layerId: 'flights', id: 'def456' }), null);
  assert.equal(
    resolveSubjectPhoto({ layerId: 'ais-live-vessels', id: 'abc123' }),
    null,
  );
  assert.equal(
    resolveSubjectPhoto({ layerId: 'military-installations', id: 'abc123' }),
    null,
  );
  assert.equal(
    resolveSubjectPhoto({ layerId: 'military', id: 'abc123' }),
    null,
  );
  assert.equal(resolveSubjectPhoto(null), null);
  current = null;
  assert.equal(resolveSubjectPhoto({ layerId: 'flights', id: 'abc123' }), null);
  current = { ...tracked, photo: null };
  assert.equal(resolveSubjectPhoto({ layerId: 'flights', id: 'abc123' }), null);
});
