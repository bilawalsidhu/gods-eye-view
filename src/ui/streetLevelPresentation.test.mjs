import assert from 'node:assert/strict';
import test from 'node:test';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
  sinceStopIndex,
} from './streetLevelPresentation.js';
import { providerSnapshot } from '../testSupport/streetLevelFakes.mjs';

const provider = providerSnapshot;

function snapshot(overrides = {}) {
  const base = {
    enabled: false,
    keyRequired: false,
    filter: { pano: 'all', sinceDays: 0 },
    providers: [provider()],
    coverage: { loading: false, count: 0, hint: '', error: null },
    legend: [
      { key: 'mapillary', label: 'Mapillary', color: '#05cb63' },
      { key: 'selected', label: 'Selected', color: '#00d4ff' },
    ],
    sequence: { providerId: null, selectedId: null, images: 0, loading: false },
    street: {
      open: false,
      follow: false,
      loading: false,
      error: null,
      providerId: null,
      providerName: null,
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

test('a key-gated layer disables every control and flags KEY REQUIRED', () => {
  const view = presentStreetLevelPanel(snapshot({ keyRequired: true }));
  assert.equal(view.controlsDisabled, true);
  assert.equal(view.status.text, 'KEY REQUIRED');
  assert.equal(view.status.tone, 'warn');
});

test('KEY REQUIRED shows no raw error code under the pill', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      keyRequired: true,
      coverage: { error: 'no_key' },
      providers: [provider({ keyRequired: true, error: 'no_key' })],
    }),
  );
  assert.equal(view.status.text, 'KEY REQUIRED');
  assert.equal(view.error, null);
  // The chip still says how to add the key.
  assert.match(view.providers[0].title, /^Mapillary: Needs /);
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
      providers: [provider({ keyRequired: true, keyRejected: true, error })],
    }),
  );
  assert.equal(view.status.text, 'KEY REJECTED');
  assert.equal(view.status.tone, 'warn');
  assert.equal(view.controlsDisabled, true);
  assert.equal(view.error, error);
  assert.equal(view.providers[0].state, 'error');
  assert.equal(view.providers[0].title, `Mapillary: ${error}`);
});

test('a key problem outranks loading on the pill: KEY REJECTED, then KEY REQUIRED (M65)', () => {
  // A keyless provider can still report loading (its status check, a retry):
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

test('one chip per provider: on, off, loading, and keyless as an error chip', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      providers: [
        provider(),
        provider({
          id: 'panoramax',
          name: 'Panoramax',
          label: 'PANORAMAX',
          on: false,
          requiresKeyId: null,
        }),
        provider({
          id: 'kartaview',
          name: 'KartaView',
          label: 'KARTAVIEW',
          loading: true,
          requiresKeyId: null,
        }),
        provider({
          id: 'google-street-view',
          name: 'Google Street View',
          label: 'STREET VIEW',
          keyRequired: true,
          requiresKeyId: 'google-maps',
        }),
      ],
    }),
  );
  assert.deepEqual(
    view.providers.map((chip) => [chip.id, chip.active, chip.state, chip.busy]),
    [
      ['mapillary', true, 'active', false],
      ['panoramax', false, 'idle', false],
      ['kartaview', true, 'loading', true],
      ['google-street-view', true, 'error', false],
    ],
  );
  assert.equal(view.providers[0].label, 'MAPILLARY');
  assert.equal(view.providers[1].title, 'Panoramax imagery off');
  assert.match(
    view.providers[3].title,
    /^Google Street View: Needs GOOGLE_MAPS_API_KEY/,
  );
  assert.ok(view.providers.every((chip) => chip.disabled === false));
});

test('a provider error is explained on its chip', () => {
  const view = presentStreetLevelPanel(
    snapshot({ providers: [provider({ error: 'Tile HTTP 502' })] }),
  );
  assert.equal(view.providers[0].title, 'Mapillary: Tile HTTP 502');
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

test('chips are dark while the layer is off, so the chip is the layer switch', () => {
  const view = presentStreetLevelPanel(snapshot({ enabled: false }));
  assert.deepEqual(
    view.providers.map((chip) => [chip.id, chip.active, chip.state]),
    [['mapillary', false, 'idle']],
  );
  assert.equal(view.providers[0].title, 'Mapillary imagery off');
  assert.equal(view.enableButton, undefined, 'no separate ON/OFF button');
  const keyless = presentStreetLevelPanel(
    snapshot({ providers: [provider({ keyRequired: true })] }),
  );
  assert.equal(
    keyless.providers[0].state,
    'error',
    'a keyless chip still says why',
  );
});

test('the SINCE slider runs from any date on the left to the last month on the right', () => {
  assert.deepEqual(
    SINCE_STOPS.map((stop) => stop.days),
    [0, 3652, 1826, 1095, 730, 365, 182, 91, 30],
  );
  assert.equal(sinceStopIndex(0), 0);
  assert.equal(sinceStopIndex(365), 5);
  assert.equal(
    sinceStopIndex(400),
    5,
    'an off-stop link lands on the nearest stop',
  );
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

test('legend passes through in the layer’s order', () => {
  const view = presentStreetLevelPanel(snapshot());
  assert.deepEqual(
    view.legend.map((entry) => entry.key),
    ['mapillary', 'selected'],
  );
});

test('each provider chip carries its source colour', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      providers: [
        provider(),
        provider({ id: 'panoramax', label: 'PANORAMAX', color: '#a66bff' }),
      ],
    }),
  );
  assert.deepEqual(
    view.providers.map((chip) => [chip.id, chip.color]),
    [
      ['mapillary', '#05cb63'],
      ['panoramax', '#a66bff'],
    ],
  );
});

test('the meta line never mixes the visible-sequence count with the selected sequence', () => {
  assert.equal(
    presentStreetLevelPanel(snapshot()).meta,
    'Switch a provider on to draw its coverage.',
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

test('viewer caption reads "Image by" left, date right, and links to the provider', () => {
  const view = presentStreetLevelPanel(
    snapshot({
      enabled: true,
      street: {
        open: true,
        providerId: 'mapillary',
        providerName: 'Mapillary',
        providerLabel: 'MAPILLARY',
        imageId: '1814275685699406',
        creator: 'mapfool',
        capturedAt: Date.UTC(2023, 9, 8),
        bearing: 93.4,
        isPano: true,
        externalUrl:
          'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
        followAvailable: true,
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
  assert.equal(view.viewer.follow.disabled, false);
  assert.equal(view.wantsOpen, true);
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

test('FOLLOW is disabled off Google 3D and says where to switch', () => {
  const open = { open: true, imageId: '1' };
  const off3d = presentStreetLevelPanel(
    snapshot({ street: { ...open, followAvailable: false } }),
  );
  assert.equal(off3d.viewer.follow.disabled, true);
  assert.match(
    off3d.viewer.follow.title,
    /needs the Google 3D map.*MAP SOURCE/,
  );
  const on3d = presentStreetLevelPanel(
    snapshot({ street: { ...open, followAvailable: true } }),
  );
  assert.equal(on3d.viewer.follow.disabled, false);
  assert.match(on3d.viewer.follow.title, /^Camera follows view/);
  const closed = presentStreetLevelPanel(
    snapshot({ street: { open: false, followAvailable: true } }),
  );
  assert.equal(closed.viewer.follow.disabled, true, 'nothing to follow');
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
  assert.equal(
    view.meta,
    `${(2514).toLocaleString()} sequences in view · click a line for its photos · click a street to open Street View`,
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
