import test from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../i18n/index.js';
import { SdrController } from '../sdr/controller.js';
import { LocalSdrControls } from './localSdrControls.js';
import { localSdrCardView } from './localSdrPresentation.js';

function stubDocument() {
  const elements = new Map();
  const doc = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = new Map();
        elements.set(id, {
          id,
          value: '',
          hidden: false,
          disabled: false,
          textContent: '',
          ownerDocument: doc,
          classList: { toggle() {} },
          setAttribute() {},
          closest: () => null,
          addEventListener(type, handler) {
            listeners.set(type, handler);
          },
        });
      }
      return elements.get(id);
    },
  };
  return doc;
}

function stubRadio() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stopPlayback() {},
    emit(state) {
      for (const fn of listeners) fn(state);
    },
  };
}

async function stopLocalFmForInternetRadio(t, locale) {
  setLocale(locale);
  const receiver = new SdrController({ webUsb: {}, storage: null });
  // Pretend local FM is streaming (no real device: stop() has nothing to tear down).
  receiver._setState({ connected: true, status: 'streaming', mode: 'fm' });
  const radio = stubRadio();
  const controls = new LocalSdrControls({
    document: stubDocument(),
    receiver,
    radio,
  });
  t.after(() => {
    controls.destroy();
    setLocale('en');
  });

  radio.emit({ audioState: 'playing' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(receiver.state.connected, false);
  return localSdrCardView(receiver.state);
}

for (const locale of ['es', 'ru']) {
  test(`FM stop message after internet radio start is shown in ${locale}`, async (t) => {
    const view = await stopLocalFmForInternetRadio(t, locale);
    assert.notEqual(
      view.connectLabel,
      'CONNECT',
      'surrounding UI is translated',
    );
    assert.notEqual(
      view.statusText,
      'Local FM stopped: internet radio started',
      `status must not be the English literal under ${locale}`,
    );
  });
}

test('FM stop message after internet radio start stays English', async (t) => {
  const view = await stopLocalFmForInternetRadio(t, 'en');
  assert.equal(view.statusText, 'Local FM stopped: internet radio started');
});
