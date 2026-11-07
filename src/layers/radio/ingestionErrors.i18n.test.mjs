import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t, translateKnown } from '../../i18n/index.js';
import { createIngestion } from './ingestion.js';

/**
 * Directory errors are stored in English in layer state (layerPanel and the
 * Radio panel translate them when shown). Every error the ingestion can set
 * must therefore have a catalog entry in each shipped language.
 */

function makeIngestion({ stations = [], body = null, failure = null } = {}) {
  const layerState = {
    _enabled: true,
    _requestGeneration: 0,
    _sessionGeneration: 0,
    _abortController: null,
    _loading: false,
    _error: null,
    _stale: false,
    _degraded: false,
    _stations: stations,
    _updatedAt: null,
    _tuningActive: false,
    _cancelledTuningPresentationStation: null,
    _acceptedCatalogSnapshot: { generation: null, instance: null },
  };
  const parts = {
    presentation: { emitState() {} },
    model: { radioRequestIsCurrent: () => true },
    catalogModel: {
      isValidRadioDirectoryStation: () => true,
      freezeRadioStation: (station) => station,
      createAcceptedCatalogSnapshot: () => null,
    },
    rendering: { reconcileStations() {}, updateSelectionEntity() {} },
  };
  const source = {
    async getDirectory() {
      if (failure) throw failure;
      return body;
    },
  };
  const { methods } = createIngestion({
    state: layerState,
    services: {},
    parts,
    source,
  });
  return { layerState, methods };
}

const degradedBody = () => ({
  stations: [{ id: 'a' }],
  updatedAt: new Date().toISOString(),
  stale: false,
  degraded: true,
  acceptedGeneration: 1,
  catalogInstance: 'instance-1',
});

const CASES = [
  {
    name: 'directory unavailable without a catalog',
    options: { failure: new Error('network') },
    expected: 'Radio directory is temporarily unavailable.',
  },
  {
    name: 'refresh failed with a warm catalog',
    options: { stations: [{ id: 'a' }], failure: new Error('network') },
    expected: 'Directory refresh failed; showing the previous station catalog.',
  },
  {
    name: 'degraded coverage without a catalog',
    options: { body: degradedBody() },
    expected: 'Radio directory coverage is degraded.',
  },
  {
    name: 'degraded refresh with a warm catalog',
    options: { stations: [{ id: 'a' }], body: degradedBody() },
    expected:
      'Directory refresh degraded; showing the previous station catalog.',
  },
];

for (const { name, options, expected } of CASES) {
  test(`radio directory error is English in state and translated on show: ${name}`, async () => {
    const { layerState, methods } = makeIngestion(options);
    await methods.update();
    assert.equal(layerState._error, expected);
    try {
      for (const locale of ['es', 'ru']) {
        setLocale(locale);
        const shown = translateKnown(layerState._error);
        assert.notEqual(shown, expected, `${locale}: ${name}`);
        assert.equal(t(layerState._error), shown);
      }
    } finally {
      setLocale('en');
    }
  });
}
