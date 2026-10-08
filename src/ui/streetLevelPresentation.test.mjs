import assert from 'node:assert/strict';
import test from 'node:test';
import {
  presentStreetLevelPanel,
  sinceStopIndex,
} from './streetLevelPresentation.js';
function snapshot(overrides = {}) {
  const base = {
    enabled: false,
    providerOn: true,
    keyRequired: false,
    keyRejected: false,
    filter: { pano: 'all', sinceDays: 0 },
    coverage: { loading: false, count: 0, hint: '', error: null },
    sequence: { selectedId: null, images: 0, loading: false },
    street: {
      open: false,
      loading: false,
      error: null,
      imageId: null,
      position: null,
      bearing: null,
      isPano: false,
      capturedAt: null,
      sequenceId: null,
      creator: null,
      externalUrl: null,
      renderMode: 'letterbox',
    },
  };
  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object'
        ? deepMerge(target[key], value)
        : value;
  }
  return out;
}

test('KEY REQUIRED disables every control and says how to add the key', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      keyRequired: true,
      coverage: { error: 'no_key' },
    }),
  );
  assert.equal(view.controlsDisabled, true);
  assert.equal(view.status.text, 'KEY REQUIRED');
  assert.equal(view.status.tone, 'warn');
  assert.match(view.error, /^Mapillary: Needs MAPILLARY_CLIENT_TOKEN/);
});

test('a key Mapillary rejected reads KEY REJECTED and names the fix', () => {
  const error =
    'Mapillary rejected MAPILLARY_CLIENT_TOKEN — replace it in Provider Settings';
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      keyRequired: true,
      keyRejected: true,
      coverage: { error },
    }),
  );
  assert.equal(view.status.text, 'KEY REJECTED');
  assert.equal(view.status.tone, 'warn');
  assert.equal(view.controlsDisabled, true);
  assert.equal(view.error, error);
});

test('a key problem outranks loading on the pill: KEY REJECTED, then KEY REQUIRED (M65)', () => {
  // A keyless layer can still report loading (its status check, a retry):
  // the pill must say what is wrong, not that something is on its way.
  const loading = { enabled: true, coverage: { loading: true } };
  assert.equal(
    presentStreetLevelPanel(snapshot({ ...loading, keyRequired: true })).status
      .text,
    'KEY REQUIRED',
  );
  assert.equal(
    presentStreetLevelPanel(
      snapshot({ ...loading, keyRequired: true, keyRejected: true }),
    ).status.text,
    'KEY REJECTED',
  );
});

test('the header pill is the on/off switch and reads OFF, LOADING or ON', () => {
  assert.deepEqual(presentStreetLevelPanel(snapshot()).status, {
    text: 'OFF',
    tone: '',
    pressed: false,
    title: 'Turn Street Level on',
  });
  assert.deepEqual(
    presentStreetLevelPanel(
      snapshot({ enabled: true, coverage: { loading: true } }),
    ).status,
    {
      text: 'LOADING',
      tone: 'busy',
      pressed: true,
      title: 'Turn Street Level off',
    },
  );
  assert.deepEqual(
    presentStreetLevelPanel(snapshot({ enabled: true })).status,
    { text: 'ON', tone: 'on', pressed: true, title: 'Turn Street Level off' },
  );
  assert.equal(
    presentStreetLevelPanel(snapshot({ enabled: true, keyRequired: true }))
      .status.pressed,
    true,
    'a keyless layer that is on can still be switched off',
  );
});

test('errors from the viewer or the coverage web surface in one alert', () => {
  assert.equal(presentStreetLevelPanel(snapshot()).error, null);
  assert.equal(
    presentStreetLevelPanel(
      snapshot({ street: { error: 'Image could not be opened' } }),
    ).error,
    'Image could not be opened',
  );
  assert.equal(
    presentStreetLevelPanel(snapshot({ coverage: { error: 'Tile HTTP 502' } }))
      .error,
    'Tile HTTP 502',
  );
});

test('a SINCE window from a link lands on the nearest slider stop', () => {
  assert.equal(sinceStopIndex(0), 0);
  assert.equal(sinceStopIndex(365), 5);
  assert.equal(sinceStopIndex(400), 5);
  assert.equal(sinceStopIndex(-4), 0);
});

test('the SINCE readout names the window and the cut-off date it means today', () => {
  const now = Date.UTC(2026, 8, 25);
  const any = presentStreetLevelPanel(snapshot(), { now });
  assert.deepEqual(any.since, { index: 0, days: 0, label: 'ANY DATE' });
  const year = presentStreetLevelPanel(
    snapshot({ filter: { pano: 'pano', sinceDays: 365 } }),
    { now },
  );
  assert.deepEqual(year.filter, { pano: 'pano', sinceDays: 365 });
  assert.deepEqual(year.since, {
    index: 5,
    days: 365,
    label: 'LAST YEAR · SINCE 2025-09-25',
  });
  const custom = presentStreetLevelPanel(
    snapshot({ filter: { pano: 'all', sinceDays: 400 } }),
    { now },
  );
  assert.equal(custom.since.index, 5);
  assert.equal(custom.since.label, 'LAST 400 DAYS · SINCE 2025-08-21');
});

test('the meta line never mixes the visible-sequence count with the selected sequence', () => {
  assert.equal(
    presentStreetLevelPanel(snapshot()).meta,
    'Switch Street Level on to draw its coverage.',
  );
  const browsing = presentStreetLevelPanel(
    snapshot({ enabled: true, coverage: { count: 812 } }),
  );
  assert.match(browsing.meta, /^812 sequences in view · click a line/);
  const selected = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      coverage: { count: 812 },
      sequence: { selectedId: 'abc', images: 33 },
    }),
  );
  assert.equal(selected.meta, '33 images in this sequence · Esc clears');
  assert.doesNotMatch(selected.meta, /sequences in view/);
  const hinted = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      coverage: { hint: 'Point the camera at the globe' },
    }),
  );
  assert.equal(hinted.meta, 'Point the camera at the globe');
});

test('viewer caption reads "Image by" left, date right, and links to Mapillary', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      street: {
        open: true,
        imageId: '1814275685699406',
        creator: 'mapfool',
        capturedAt: Date.UTC(2023, 9, 8),
        bearing: 93.4,
        isPano: true,
        externalUrl:
          'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
      },
    }),
  );
  assert.equal(view.viewer.captionLeft, 'Image by mapfool');
  assert.equal(view.viewer.captionRight, '360° · 93° · 2023-10-08');
  assert.equal(
    view.viewer.link,
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(view.viewer.linkLabel, 'MAPILLARY ↗');
  assert.equal(view.viewer.open, true);
});

test('an image without a creator name leaves the left caption empty', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      street: { open: true, imageId: '1', capturedAt: Date.UTC(2024, 0, 2) },
    }),
  );
  assert.equal(view.viewer.captionLeft, '');
  assert.equal(view.viewer.captionRight, '2024-01-02');
  assert.equal(view.viewer.link, null);
  assert.equal(view.viewer.linkLabel, '');
});
