import assert from 'node:assert/strict';
import test from 'node:test';
import {
  presentStreetLevelPanel,
  sinceStopIndex,
} from './streetLevelPresentation.js';
import { providerSnapshot } from '../testSupport/streetLevelFakes.mjs';

const provider = providerSnapshot;

test('an empty composition explains unavailable imagery even while disabled', () => {
  for (const enabled of [false, true]) {
    const view = presentStreetLevelPanel(
      snapshot({
        enabled,
        providers: [],
        coverage: { hint: 'No street-level imagery providers configured' },
      }),
    );
    assert.equal(view.controlsDisabled, true);
    assert.equal(view.keyRequired, false);
    assert.deepEqual(view.providers, []);
    assert.equal(view.meta, 'No street-level imagery providers configured');
  }
});

function snapshot(overrides = {}) {
  const base = {
    enabled: false,
    // The one provider's key state follows the summary the test asks for.
    providers: [
      provider({
        keyRequired: overrides.keyRequired === true,
        keyRejected: overrides.keyRejected === true,
      }),
    ],
    keyRequired: false,
    keyRejected: false,
    filter: { pano: 'all', sinceDays: 0 },
    coverage: { loading: false, count: 0, hint: '', error: null },
    sequence: { selectedId: null, images: 0, loading: false },
    street: {
      open: false,
      loading: false,
      error: null,
      providerLabel: null,
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
  assert.match(view.error, /^Needs MAPILLARY_CLIENT_TOKEN/);
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

test('errors from the viewer, the sequence or the coverage surface in one alert', () => {
  assert.equal(presentStreetLevelPanel(snapshot()).error, null);
  assert.equal(
    presentStreetLevelPanel(
      snapshot({ street: { error: 'Image could not be opened' } }),
    ).error,
    'Image could not be opened',
  );
  assert.equal(
    presentStreetLevelPanel(
      snapshot({ sequence: { error: 'Sequence images unavailable' } }),
    ).error,
    'Sequence images unavailable',
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

test('an empty view says so, and whether the filter emptied it', () => {
  const meta = (overrides) =>
    presentStreetLevelPanel(snapshot({ enabled: true, ...overrides })).meta;
  assert.equal(meta({}), 'No coverage in view');
  assert.equal(
    meta({ filter: { pano: 'flat', sinceDays: 0 } }),
    'No sequences in view match the filter',
  );
  assert.equal(
    meta({ filter: { pano: 'all', sinceDays: 365 } }),
    'No sequences in view match the filter',
  );
  // Nothing to claim while it loads, or when the error line explains it.
  assert.equal(meta({ coverage: { loading: true } }), '');
  assert.equal(meta({ keyRequired: true }), '');
  assert.equal(meta({ coverage: { error: 'Tile HTTP 502' } }), '');
});

test('viewer caption reads "Image by" left, date right, and links to Mapillary', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      street: {
        open: true,
        providerLabel: 'MAPILLARY',
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

test('a bearing that rounds to north reads 0°, not 360°', () => {
  const caption = (bearing) =>
    presentStreetLevelPanel(snapshot({ street: { open: true, bearing } }))
      .viewer.captionRight;
  assert.equal(caption(359.4), '359°');
  assert.equal(caption(359.6), '0°');
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

test('a Street View caption names the place, dates it by month, and offers no FIT/FILL', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      street: {
        open: true,
        providerId: 'google',
        providerName: 'Google Street View',
        providerLabel: 'STREET VIEW',
        imageId: 'pano-1',
        title: '1014 10th St',
        creator: 'Google',
        capturedAt: Date.UTC(2023, 0, 1),
        capturedAtPrecision: 'month',
        bearing: 0,
        isPano: true,
        renderModes: false,
        externalUrl:
          'https://www.google.com/maps/@?api=1&map_action=pano&pano=pano-1',
      },
    }),
  );
  assert.equal(view.viewer.captionLeft, '1014 10th St · Image by Google');
  assert.equal(view.viewer.captionRight, '360° · 0° · 2023-01');
  assert.equal(view.viewer.linkLabel, 'STREET VIEW ↗');
  assert.equal(view.viewer.renderModes, false);
});

test('the meta line keeps the sequence count and adds the other providers’ hints', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      coverage: {
        loading: false,
        count: 2514,
        hint: 'click a street to open Street View',
        error: null,
      },
    }),
  );
  // The count follows the app locale (formatNumber under the default 'en'),
  // not the system locale of the Node process running the tests.
  assert.equal(
    view.meta,
    '2,514 sequences in view · click a line for its photos · click a street to open Street View',
  );
});

test('OPEN STREET VIEW shows while Street View is on, and waits for street zoom', () => {
  const streetView = provider({
    id: 'google',
    name: 'Google Street View',
    label: 'STREET VIEW',
    groundClick: true,
    requiresKeyId: 'google-maps',
  });
  const view = (overrides) =>
    presentStreetLevelPanel(
      snapshot({
        enabled: true,
        providers: [provider(), streetView],
        ...overrides,
      }),
    ).nearest;
  const ready = view({ groundClickReady: true });
  assert.deepEqual(ready, {
    visible: true,
    label: 'OPEN STREET VIEW',
    title: 'Open Google Street View at the centre of the view',
    disabled: false,
    providerIds: ['google'],
  });
  const high = view({ groundClickReady: false });
  assert.equal(high.disabled, true);
  assert.equal(
    high.title,
    'Zoom in to a street to open Google Street View here',
  );
  // Hidden with Street View off, without its key, or with the layer off
  // (off Google 3D the provider is not listed at all).
  assert.equal(
    view({ providers: [provider(), { ...streetView, on: false }] }).visible,
    false,
  );
  assert.equal(
    view({ providers: [provider(), { ...streetView, keyRequired: true }] })
      .visible,
    false,
  );
  assert.equal(view({ providers: [provider()] }).visible, false);
  assert.equal(
    presentStreetLevelPanel(snapshot({ providers: [provider(), streetView] }))
      .nearest.visible,
    false,
  );
});

test('KEY REQUIRED points at Street View when it would draw with the Google key', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      keyRequired: true,
      providers: [
        provider({ keyRequired: true, configured: false }),
        provider({
          id: 'google',
          name: 'Google Street View',
          label: 'STREET VIEW',
          on: false,
          configured: true,
          requiresKeyId: 'google-maps',
        }),
      ],
      keyAlternatives: [
        { id: 'google', label: 'STREET VIEW', requiresKeyId: 'google-maps' },
      ],
    }),
  );
  const guidance =
    'Needs MAPILLARY_CLIENT_TOKEN — add it in Provider Settings, or light STREET VIEW to use your Google Maps key';
  assert.equal(view.status.text, 'KEY REQUIRED');
  assert.equal(view.status.title, guidance);
  assert.equal(view.meta, guidance);
  // Off Google 3D Street View is not listed: plain KEY REQUIRED.
  const plain = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      keyRequired: true,
      providers: [provider({ keyRequired: true, configured: false })],
      keyAlternatives: [],
    }),
  );
  assert.equal(plain.status.text, 'KEY REQUIRED');
  assert.notEqual(plain.meta, guidance);
});

test('the caption names an image’s own licence after its author, and leaves it out when there is none', () => {
  const caption = (street) =>
    presentStreetLevelPanel({
      enabled: true,
      providers: [],
      coverage: {},
      legend: [],
      filter: {},
      sequence: {},
      street: { open: true, imageId: '1', ...street },
    }).viewer.captionLeft;
  assert.equal(
    caption({ creator: 'Fixture Mapper', license: 'CC BY-SA 4.0' }),
    'Image by Fixture Mapper · CC BY-SA 4.0',
  );
  assert.equal(
    caption({ license: 'Licence Ouverte 2.0' }),
    'Licence Ouverte 2.0',
  );
  assert.equal(caption({ creator: 'Someone' }), 'Image by Someone');
});
