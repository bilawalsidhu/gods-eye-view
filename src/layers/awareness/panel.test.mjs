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

test('only the tracked flight has a photo: not a vessel, an installation, a military aircraft or another flight', () => {
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
