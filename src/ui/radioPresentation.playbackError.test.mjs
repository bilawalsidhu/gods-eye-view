import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { renderRadioState } from './radioPresentation.js';

function el() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {
      toggle(name, on) {
        on ? classes.add(name) : classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

function render(audioError) {
  globalThis.document = { getElementById: () => null, activeElement: null };
  const host = {
    destroyed: false,
    _radioPanel: el(),
    _radioPlaybackState: el(),
    _syncContextRadioLauncherState() {},
    actions: {
      getLifecycle: () => null,
      preservePanelStateDuringClear: () => false,
      setPanelCollapsed() {},
      scheduleLayout() {},
    },
  };
  renderRadioState.call(host, {
    enabled: true,
    audioState: 'error',
    audioError,
    filteredCount: 1,
    stationCount: 1,
    volume: 1,
  });
  return host._radioPlaybackState.textContent;
}

const PLAYBACK_ERRORS = [
  'Playback requires a direct click or tap.',
  'Broadcaster stream could not be started.',
  'Broadcaster stream is unavailable or blocked by the browser.',
];

for (const locale of ['es', 'ru']) {
  test(`radio playback errors are localized in ${locale}`, () => {
    setLocale(locale);
    try {
      for (const message of PLAYBACK_ERRORS) {
        assert.notEqual(render(message), message, `${locale}: ${message}`);
      }
      // Control: the fallback (no audioError) is translated.
      assert.notEqual(render(null), 'Broadcaster stream unavailable');
    } finally {
      setLocale('en');
    }
  });
}

test('radio playback errors stay English', () => {
  setLocale('en');
  for (const message of PLAYBACK_ERRORS) {
    assert.equal(render(message), message);
  }
  assert.equal(render(null), 'Broadcaster stream unavailable');
});
