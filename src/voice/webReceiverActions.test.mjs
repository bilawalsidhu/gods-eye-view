import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  findWebReceivers,
  showRfSpectrum,
  spectrumRangeHz,
  tuneWebReceiver,
} from './gevActions.js';
import {
  buildSpectrumUrl,
  buildTuneUrl,
  formatFrequencyHz,
  rankWebReceivers,
  receiverCoversHz,
  receiverCoversRangeHz,
} from '../sources/webReceivers.js';

const KIWI = {
  id: 'aaaaaaaaaaaa',
  type: 'kiwisdr',
  typeLabel: 'KiwiSDR',
  name: 'Kiwi Arvika',
  site: 'Arvika',
  url: 'http://sa4bna.hopto.org:8073/',
  lat: 59.546,
  lon: 12.526,
  bands: [{ lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' }],
  users: 3,
  usersMax: 8,
  online: true,
};
const TWENTE = {
  id: 'bbbbbbbbbbbb',
  type: 'websdr',
  typeLabel: 'WebSDR',
  name: 'WebSDR Twente',
  site: 'Enschede',
  url: 'http://websdr.ewi.utwente.nl:8901/',
  lat: 52.2292,
  lon: 6.875,
  bands: [{ lowHz: 0, highHz: 29_160_000, label: '0–29 MHz' }],
  users: null,
  usersMax: null,
  online: null,
};
const OWRX = {
  id: 'cccccccccccc',
  type: 'openwebrx',
  typeLabel: 'OpenWebRX',
  name: 'OWRX Berlin 2m/70cm',
  site: 'Berlin',
  url: 'http://thomas0177.ddns.net:8073/',
  lat: 52.41876,
  lon: 13.30633,
  bands: [{ lowHz: 144e6, highHz: 148e6, label: '2 m' }],
  users: null,
  usersMax: null,
  online: null,
};

function harness({ receivers = [KIWI, TWENTE, OWRX], enabled = false } = {}) {
  const calls = [];
  const state = { selected: null };
  const byId = (id) => receivers.find((entry) => entry.id === id) || null;
  const module = {
    async ensureLoaded() {
      calls.push('ensureLoaded');
      return receivers;
    },
    getReceivers: () => receivers,
    getReceiver: byId,
    resolveReceiver: (query) =>
      receivers.find((entry) =>
        entry.name.toLowerCase().includes(String(query).toLowerCase()),
      ) || null,
    getUIState: () => state,
    find: (request) => {
      calls.push(['find', request]);
      return rankWebReceivers(receivers, request);
    },
    frame: (ids) => calls.push(['frame', ids]),
    selectReceiver: (id, options) => {
      calls.push(['select', id, options.flyTo]);
      state.selected = byId(id);
      return state.selected;
    },
    tune: ({ receiverId, hz, mode }) => {
      const receiver = byId(receiverId);
      return {
        ok: true,
        url: buildTuneUrl(receiver, { hz, mode }),
        frequencyLabel: formatFrequencyHz(hz),
        covers: receiverCoversHz(receiver, hz),
      };
    },
    showSpectrum: ({ receiverId, lowHz, highHz }) => {
      const receiver = byId(receiverId);
      const view = buildSpectrumUrl(receiver, { lowHz, highHz });
      return {
        ok: true,
        url: view.url,
        rangeLabel: view.rangeLabel,
        muted: view.muted,
        zoom: view.zoom,
        shownSpanHz: view.shownSpanHz,
        covers: receiverCoversRangeHz(receiver, lowHz, highHz),
        note: view.note,
      };
    },
  };
  const dataManager = {
    layers: new Map([['web-receivers', { module }]]),
    enabled,
    isEnabled() {
      return this.enabled;
    },
    async setEnabled(id, value, options) {
      calls.push(['setEnabled', id, value, options.origin]);
      this.enabled = value;
      return true;
    },
    getLayerLifecycleState: () => ({
      enabled: true,
      lifecycleState: 'enabled',
      uncertain: false,
    }),
  };
  const viewer = {
    scene: { canvas: { clientWidth: 200, clientHeight: 100 } },
    camera: {
      pickEllipsoid: () => undefined,
      positionCartographic: Cesium.Cartographic.fromDegrees(13.4, 52.52, 500),
    },
  };
  return { viewer, dataManager, module, state, calls };
}

test('find_web_receivers enables the layer, ranks around the coordinates and frames the results', async () => {
  const { viewer, dataManager, calls } = harness();
  const result = await findWebReceivers(viewer, dataManager, {
    latitude: 52.52,
    longitude: 13.4,
    frequencyKhz: 14233,
    limit: 5,
  });
  assert.deepEqual(calls[0], ['setEnabled', 'web-receivers', true, 'voice']);
  assert.equal(calls[1], 'ensureLoaded');
  assert.equal(result.ok, true);
  assert.equal(result.action, 'find_web_receivers');
  assert.equal(result.scopeLabel, 'around 52.520, 13.400');
  assert.equal(result.frequencyLabel, '14,233 kHz');
  assert.deepEqual(
    result.results.map((row) => row.id),
    ['bbbbbbbbbbbb', 'aaaaaaaaaaaa'],
    'coverage is required when a frequency is given: the 2 m receiver drops out',
  );
  assert.equal(result.results[0].coversFrequency, true);
  assert.equal(typeof result.results[0].distanceKm, 'number');
  assert.deepEqual(calls.at(-1), ['frame', ['bbbbbbbbbbbb', 'aaaaaaaaaaaa']]);
  assert.equal(result.lifecycleState, 'enabled');

  const view = await findWebReceivers(viewer, dataManager, {
    band: 'vhf',
    frameResults: false,
  });
  assert.equal(view.scopeLabel, 'around the current view');
  assert.deepEqual(
    view.results.map((row) => row.id),
    ['cccccccccccc'],
  );
  assert.ok(!calls.slice(-2).some((call) => call[0] === 'frame'));
});

test('find_web_receivers reports an unplaceable query and an unavailable layer', async () => {
  const { viewer, dataManager } = harness();
  await assert.rejects(
    findWebReceivers(
      viewer,
      dataManager,
      { locationQuery: 'Nowhere Specific' },
      { placeSearch: { geocode: async () => ({ place: null }) } },
    ),
    /Could not place "Nowhere Specific"/,
  );
  await assert.rejects(
    findWebReceivers(viewer, { layers: new Map(), isEnabled: () => false }, {}),
    /Web Receivers layer unavailable/,
  );
});

test('tune_web_receiver resolves by name, by selection and by the nearest covering receiver', async () => {
  const { viewer, dataManager, state, calls } = harness({ enabled: true });
  const byName = await tuneWebReceiver(viewer, dataManager, {
    receiverQuery: 'twente',
    frequencyKhz: 14233,
  });
  assert.equal(byName.ok, true);
  assert.equal(byName.resolvedBy, 'query');
  assert.equal(byName.mode, 'usb', 'the band default applies without a mode');
  assert.equal(
    byName.tuneUrl,
    'http://websdr.ewi.utwente.nl:8901/?tune=14233usb',
  );
  assert.equal(byName.openedIn, 'dock');
  assert.equal(byName.covers, true);
  assert.deepEqual(calls.at(-1), ['select', 'bbbbbbbbbbbb', true]);
  assert.equal(state.selected.id, 'bbbbbbbbbbbb');

  const selected = await tuneWebReceiver(viewer, dataManager, {
    frequencyKhz: 7055.5,
    mode: 'lsb',
    openIn: 'tab',
  });
  assert.equal(selected.resolvedBy, 'selected');
  assert.equal(
    selected.tuneUrl,
    'http://websdr.ewi.utwente.nl:8901/?tune=7055.5lsb',
  );
  assert.equal(selected.openedIn, 'tab');

  const nearest = await tuneWebReceiver(viewer, dataManager, {
    target: 'nearest',
    latitude: 59.5,
    longitude: 12.5,
    frequencyKhz: 5000,
    mode: 'am',
  });
  assert.equal(nearest.resolvedBy, 'nearest');
  assert.equal(nearest.receiver.id, 'aaaaaaaaaaaa');
  assert.equal(nearest.tuneUrl, 'http://sa4bna.hopto.org:8073/?f=5000amz8');

  const none = await tuneWebReceiver(viewer, dataManager, {
    target: 'nearest',
    frequencyKhz: 145500,
    latitude: 59.5,
    longitude: 12.5,
  });
  assert.equal(none.ok, true, 'the 2 m OpenWebRX covers 145.5 MHz');
  assert.equal(none.receiver.id, 'cccccccccccc');

  const missing = await tuneWebReceiver(viewer, dataManager, {
    receiverQuery: 'no such receiver',
    frequencyKhz: 14233,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No web receiver matched/);
  assert.equal((await tuneWebReceiver(viewer, dataManager, {})).ok, false);
});

test('show_rf_spectrum reads either range form and prefers a KiwiSDR that covers it', async () => {
  assert.deepEqual(
    spectrumRangeHz({ startKhz: 10000, stopKhz: 15000 }),
    [10_000_000, 15_000_000],
  );
  assert.deepEqual(
    spectrumRangeHz({ centerKhz: 7100, spanKhz: 200 }),
    [7_000_000, 7_200_000],
  );
  assert.equal(spectrumRangeHz({ startKhz: 15000, stopKhz: 10000 }), null);
  assert.equal(spectrumRangeHz({}), null);

  const { viewer, dataManager } = harness({ enabled: true });
  const kiwi = await showRfSpectrum(viewer, dataManager, {
    startKhz: 10000,
    stopKhz: 15000,
    latitude: 52.52,
    longitude: 13.4,
  });
  assert.equal(kiwi.ok, true);
  assert.equal(
    kiwi.receiver.id,
    'aaaaaaaaaaaa',
    'KiwiSDR preferred over the nearer WebSDR',
  );
  assert.equal(kiwi.muted, true);
  assert.equal(kiwi.zoom, 2);
  assert.equal(
    kiwi.spectrumUrl,
    'http://sa4bna.hopto.org:8073/?f=12500amz2&sp=1&mute=1',
  );
  assert.equal(kiwi.scopeLabel, 'around 52.520, 13.400');

  const named = await showRfSpectrum(viewer, dataManager, {
    receiverQuery: 'twente',
    centerKhz: 7100,
    spanKhz: 200,
  });
  assert.equal(named.muted, false, 'a WebSDR page cannot be muted from a link');
  assert.match(named.note, /cannot be zoomed or muted/);

  const wide = await showRfSpectrum(viewer, dataManager, {
    startKhz: 1000,
    stopKhz: 60000,
  });
  assert.equal(wide.ok, false);
  assert.match(wide.error, /40 MHz/);
  const none = await showRfSpectrum(viewer, dataManager, {});
  assert.equal(none.ok, false);
  assert.match(none.error, /frequency range is required/);
});
