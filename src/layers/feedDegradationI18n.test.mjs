// Feed errors stay English in layer stats (what voice, the analyst and the
// HUD summary receive) and show in the UI language in the Layers panel,
// through ui/statusText.js, exactly as the layers used to translate them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../i18n/index.js';
import { translateFeedError } from '../ui/statusText.js';
import {
  AIS_FIRST_CONNECT_GRACE_MS,
  classifyAisFeedSnapshot,
  deriveAisFeedError,
  _applyAisFeedSnapshotForTest,
  _beginAisSessionForTest,
  _getVesselFeedStateForTest,
  _setAisRuntimeForTest,
  _setVesselStateForTest,
} from '../data/aisLiveVessels.js';
import { createModel } from './traffic/model.js';
import { createFirmsState } from './firms/state.js';
import { createModel as createFirmsModel } from './firms/model.js';
import { createQueries as createFirmsQueries } from './firms/queries.js';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

/**
 * Asserts the data is the English text under `locale`, and that the panel
 * shows it as `shown()` (the text the layer used to put in the data).
 */
function assertEnglishAndShown(locale, produce, english, shown) {
  const data = inLocale(locale, produce);
  assert.equal(data, english, `${locale}: data must stay English`);
  inLocale(locale, () => {
    const presented = translateFeedError(data);
    assert.equal(presented, shown(), `${locale}: shown text for "${english}"`);
    assert.notEqual(presented, english, `${locale}: "${english}" untranslated`);
  });
}

const AIS_CASES = [
  [
    { status: 'auth-failed' },
    'API key rejected — check AISSTREAM_API_KEY',
    () => t('API key rejected — check AISSTREAM_API_KEY'),
  ],
  [
    { status: 'stale', silentForMs: 90000 },
    'feed silent 90s — no AIS data',
    () => t('feed silent {seconds}s — no AIS data', { seconds: 90 }),
  ],
  [
    { status: 'stale' },
    'feed silent — no AIS data',
    () => t('feed silent — no AIS data'),
  ],
  [
    { status: 'down', reconnectAttempt: 3 },
    'feed down — retrying slowly (attempt 3)',
    () => t('feed down — retrying slowly (attempt {attempt})', { attempt: 3 }),
  ],
  [
    { status: 'down' },
    'feed down — retrying slowly',
    () => t('feed down — retrying slowly'),
  ],
  [
    { status: 'reconnecting', reconnectAttempt: 2 },
    'reconnecting to feed… (attempt 2)',
    () => t('reconnecting to feed… (attempt {attempt})', { attempt: 2 }),
  ],
  [
    { status: 'reconnecting' },
    'reconnecting to feed…',
    () => t('reconnecting to feed…'),
  ],
  [
    { status: 'open', lastMessageAt: 5 },
    'awaiting usable AIS positions…',
    () => t('awaiting usable AIS positions…'),
  ],
  [
    { status: 'live', lastMessageAt: null },
    'awaiting first AIS message…',
    () => t('awaiting first AIS message…'),
  ],
  [
    { status: 'missing-key' },
    'AISSTREAM_API_KEY not set',
    () => t('AISSTREAM_API_KEY not set'),
  ],
  [
    { status: 'connecting' },
    'connecting to feed…',
    () => t('connecting to feed…'),
  ],
  [{ status: 'closed' }, 'feed disconnected', () => t('feed disconnected')],
  [{ status: 'error' }, 'feed down', () => t('feed down')],
  [
    { status: 'weird-state', error: 'something specific' },
    'feed unavailable (something specific)',
    () => `${t('feed unavailable')} (something specific)`,
  ],
];

const TRAFFIC_REASONS = [
  'TomTom key unavailable',
  'TomTom daily budget reached',
  'TomTom upstream unreachable',
  'TomTom flow unavailable',
  'TomTom flow error (HTTP 418)',
];

/** The fire layer's query half, with the scene services it never calls stubbed. */
function firmsLayer() {
  const services = {
    render: { governorRequestRender() {} },
    anchors: { fireAnchorHeight: () => 0, FIRE_ANCHOR_LIFT_M: 0 },
    overlays: {},
    sprites: {},
    context: {},
    picking: {},
    focus: {},
  };
  const config = { id: 'local-firms', name: 'FIRMS Active Fires' };
  const layerState = createFirmsState({ services, config });
  const components = {};
  const context = {
    layerState,
    services,
    components,
    config,
    feed: { getSnapshot: async () => ({}) },
  };
  components.model = createFirmsModel(context);
  return { layerState, methods: createFirmsQueries(context).methods };
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: AIS feed errors are English data, shown translated`, () => {
    for (const [payload, english, shown] of AIS_CASES) {
      assertEnglishAndShown(
        locale,
        () => deriveAisFeedError(payload, 0),
        english,
        shown,
      );
    }
    // A snapshot with no status and no usable row still says why.
    assertEnglishAndShown(
      locale,
      () => classifyAisFeedSnapshot({ rows: [] }).error,
      'awaiting usable AIS positions…',
      () => t('awaiting usable AIS positions…'),
    );
  });

  test(`${locale}: an expired AIS first connect reports English data`, () => {
    let nowMs = 1000;
    let expire = null;
    _setAisRuntimeForTest({
      now: () => nowMs,
      setTimeout(callback) {
        expire = callback;
        return {};
      },
      clearTimeout() {},
    });
    _setVesselStateForTest({ viewer: {}, records: [] });
    try {
      _beginAisSessionForTest();
      _applyAisFeedSnapshotForTest(
        {},
        {
          status: 'open',
          lastMessageAt: 5,
          rows: [],
        },
      );
      nowMs += AIS_FIRST_CONNECT_GRACE_MS;
      assertEnglishAndShown(
        locale,
        () => {
          expire();
          return _getVesselFeedStateForTest().error;
        },
        'awaiting usable AIS positions…',
        () => t('awaiting usable AIS positions…'),
      );
    } finally {
      _setVesselStateForTest({ enabled: false });
      _setAisRuntimeForTest();
    }
  });

  test(`${locale}: traffic "SIMULATED — <reason>" is English data, shown translated`, () => {
    const { trafficFeedPresentation } = createModel({
      state: {},
      services: {},
      parts: {},
      source: {},
    });
    for (const flowError of TRAFFIC_REASONS) {
      const present = () =>
        trafficFeedPresentation({ liveMode: true, flowError });
      assertEnglishAndShown(
        locale,
        () => present().error,
        `SIMULATED — ${flowError}`,
        // The loading label keeps the text the panel used to show.
        () => present().loadingLabel,
      );
    }
  });

  test(`${locale}: FIRMS key and stale errors are English data, shown translated`, () => {
    const { layerState, methods } = firmsLayer();
    layerState._keyRequired = true;
    assertEnglishAndShown(
      locale,
      () => methods.getStats().error,
      'KEY REQUIRED',
      () => t('KEY REQUIRED'),
    );

    layerState._keyRequired = false;
    layerState._stale = true;
    assertEnglishAndShown(
      locale,
      () => methods.getStats().error,
      'STALE',
      () => t('STALE'),
    );

    layerState._lastUpdate = Date.now() - 3 * 3600000;
    assertEnglishAndShown(
      locale,
      () => methods.getStats().error,
      'STALE · cached 3h',
      () => methods.getStats().loadingLabel,
    );
    assert.equal(
      inLocale(locale, () => methods.getStats().loadingLabel),
      inLocale(locale, () =>
        t('STALE · cached {age}', {
          age: t('{count}h', { context: 'age', count: 3 }),
        }),
      ),
    );
  });
}

test('English degraded-feed wording is unchanged', () => {
  setLocale('en');
  assert.equal(
    deriveAisFeedError({ status: 'down', reconnectAttempt: 3 }, 0),
    'feed down — retrying slowly (attempt 3)',
  );
  assert.equal(
    deriveAisFeedError({ status: 'reconnecting' }, 0),
    'reconnecting to feed…',
  );
  assert.equal(
    deriveAisFeedError({ status: 'missing-key' }, 0),
    'AISSTREAM_API_KEY not set',
  );
  const { trafficFeedPresentation } = createModel({
    state: {},
    services: {},
    parts: {},
    source: {},
  });
  assert.equal(
    trafficFeedPresentation({
      liveMode: true,
      flowError: 'TomTom daily budget reached',
    }).error,
    'SIMULATED — TomTom daily budget reached',
  );
});
