import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebReceiversControls } from './webReceiversControls.js';

class Element extends EventTarget {
  constructor() {
    super();
    this.attrs = new Map();
    this.classes = new Set();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.href = '';
    this.focusCount = 0;
    this.isConnected = true;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => {
        const next = on === undefined ? !this.classes.has(name) : Boolean(on);
        if (next) this.classes.add(name);
        else this.classes.delete(name);
        return next;
      },
    };
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  set innerHTML(value) {
    if (value === '') this.children = [];
  }
  get innerHTML() {
    return '';
  }
  set src(value) {
    this.setAttribute('src', value);
  }
  get src() {
    return this.getAttribute('src');
  }
  focus() {
    this.focusCount += 1;
  }
  blur() {}
}

const ELEMENT_NAMES = [
  '_webReceiversPanel',
  '_webReceiversLayerState',
  '_webReceiversEnableBtn',
  '_webReceiversType',
  '_webReceiversBand',
  '_webReceiversName',
  '_webReceiversMeta',
  '_webReceiversBands',
  '_webReceiversFreq',
  '_webReceiversMode',
  '_webReceiversTuneBtn',
  '_webReceiversOpenBtn',
  '_webReceiversSpecFrom',
  '_webReceiversSpecTo',
  '_webReceiversSpecBtn',
  '_webReceiversDock',
  '_webReceiversDockLabel',
  '_webReceiversDockLink',
  '_webReceiversDockMin',
  '_webReceiversDockClose',
  '_webReceiversFrame',
  '_webReceiversDockNote',
  '_webReceiversStatus',
];

const KIWI = {
  id: 'aaaaaaaaaaaa',
  type: 'kiwisdr',
  typeLabel: 'KiwiSDR',
  name: 'Kiwi Arvika',
  site: 'Arvika',
  url: 'http://sa4bna.hopto.org:8073/',
  users: 3,
  usersMax: 8,
  online: true,
  antenna: 'beverage',
};

function fixture(
  t,
  { enabled = false, selected = null, protocol = 'http:' } = {},
) {
  const prior = { document: globalThis.document, window: globalThis.window };
  const opened = [];
  const document = new EventTarget();
  document.createElement = () => new Element();
  document.getElementById = () => null;
  document.activeElement = null;
  document.body = new Element();
  globalThis.document = document;
  globalThis.window = Object.assign(new EventTarget(), {
    location: { protocol },
    open: (...args) => opened.push(args),
    focus() {},
  });
  t.after(() => {
    globalThis.document = prior.document;
    globalThis.window = prior.window;
  });
  const elements = Object.fromEntries(
    ELEMENT_NAMES.map((name) => [name, new Element()]),
  );
  elements._webReceiversDock.hidden = true;
  const calls = [];
  const layerState = {
    enabled,
    loading: false,
    error: null,
    stale: false,
    receiverCount: 2,
    filteredCount: 2,
    filter: { type: 'all', band: 'all' },
    filters: {
      types: [
        { id: 'all', label: 'All receivers' },
        { id: 'kiwisdr', label: 'KiwiSDR' },
      ],
      bands: [
        { id: 'all', label: 'All bands' },
        { id: 'hf', label: 'Shortwave (HF)' },
      ],
    },
    selected,
    selectedBands: selected ? '0–30 MHz' : '',
    lastTune: null,
  };
  const layer = {
    subscribers: [],
    subscribe(callback) {
      this.subscribers.push(callback);
      calls.push('subscribe');
      callback(layerState);
      return () => calls.push('unsubscribe');
    },
    getUIState: () => layerState,
    setFilter: (filter) => calls.push(['filter', filter]),
    tune: (request) => {
      calls.push(['tune', request]);
      return {
        ok: true,
        url: 'http://sa4bna.hopto.org:8073/?f=14233usbz10',
        frequencyLabel: '14,233 kHz',
        mode: 'usb',
        covers: true,
      };
    },
    showSpectrum: (request) => {
      calls.push(['spectrum', request]);
      return {
        ok: true,
        url: 'http://sa4bna.hopto.org:8073/?f=12500amz2&sp=1&mute=1',
        rangeLabel: '10,000–15,000 kHz',
        muted: true,
      };
    },
  };
  const actions = {
    isRegistered: () => true,
    isEnabled: () => layerState.enabled,
    setEnabled: async (value, options) => {
      calls.push(['setEnabled', value, options.origin]);
      return true;
    },
    getLifecycle: () => null,
    runUserAction: (operation) => operation('token'),
    setPanelCollapsed: (...args) => calls.push(['panel', ...args]),
    scheduleLayout: () => calls.push('layout'),
  };
  const controls = new WebReceiversControls({ elements, layer, actions });
  return { controls, elements, layer, layerState, calls, opened };
}

test('connect renders the off state and the enable button runs the user action', async (t) => {
  const { controls, elements, calls } = fixture(t);
  controls.connect();
  assert.deepEqual(calls, ['subscribe']);
  assert.equal(elements._webReceiversLayerState.textContent, 'OFF');
  assert.equal(elements._webReceiversEnableBtn.textContent, 'ENABLE');
  assert.equal(elements._webReceiversTuneBtn.disabled, true);
  assert.equal(elements._webReceiversType.children.length, 2);
  assert.equal(elements._webReceiversStatus.textContent, 'Web receivers off');
  elements._webReceiversEnableBtn.dispatchEvent(new Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.at(-1), ['setEnabled', true, 'user']);
  assert.equal(elements._webReceiversEnableBtn.disabled, false);
  controls.destroy();
  assert.equal(calls.at(-1), 'unsubscribe');
  elements._webReceiversEnableBtn.dispatchEvent(new Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.at(-1), 'unsubscribe', 'listeners are gone after destroy');
});

test('the enabled state with a selection unlocks the tune row and opens the dock', (t) => {
  const { controls, elements, calls } = fixture(t, {
    enabled: true,
    selected: KIWI,
  });
  controls.connect();
  assert.equal(elements._webReceiversLayerState.textContent, '2/2');
  assert.equal(elements._webReceiversName.textContent, 'KIWI ARVIKA');
  assert.match(
    elements._webReceiversMeta.textContent,
    /KiwiSDR · Arvika · 3\/8 users/,
  );
  assert.equal(elements._webReceiversBands.textContent, '0–30 MHz · beverage');
  assert.equal(elements._webReceiversTuneBtn.disabled, false);

  elements._webReceiversFreq.value = 'abc';
  elements._webReceiversTuneBtn.dispatchEvent(new Event('click'));
  assert.equal(
    elements._webReceiversStatus.textContent,
    'Enter a frequency in kHz, e.g. 14233',
  );
  assert.equal(elements._webReceiversFreq.focusCount, 1);
  assert.ok(!calls.some((call) => call[0] === 'tune'));

  elements._webReceiversFreq.value = '14233';
  elements._webReceiversMode.value = 'usb';
  elements._webReceiversTuneBtn.dispatchEvent(new Event('click'));
  assert.deepEqual(
    calls.find((call) => call[0] === 'tune'),
    ['tune', { receiverId: 'aaaaaaaaaaaa', hz: 14_233_000, mode: 'usb' }],
  );
  assert.equal(elements._webReceiversDock.hidden, false);
  assert.equal(
    elements._webReceiversFrame.getAttribute('src'),
    'http://sa4bna.hopto.org:8073/?f=14233usbz10',
  );
  assert.equal(
    elements._webReceiversDockLabel.textContent,
    'Kiwi Arvika · 14,233 kHz USB',
  );
  assert.equal(
    elements._webReceiversStatus.textContent,
    'Tuned Kiwi Arvika · 14,233 kHz USB',
  );
  assert.ok(
    calls.some(
      (call) => call[0] === 'panel' && call[1] === 'web-receivers-panel',
    ),
  );

  elements._webReceiversDockMin.dispatchEvent(new Event('click'));
  assert.equal(
    elements._webReceiversDock.classList.contains('minimized'),
    true,
  );
  assert.equal(elements._webReceiversDockMin.textContent, '▴');
  elements._webReceiversDockClose.dispatchEvent(new Event('click'));
  assert.equal(elements._webReceiversDock.hidden, true);
  assert.equal(elements._webReceiversFrame.getAttribute('src'), null);
  assert.equal(
    elements._webReceiversStatus.textContent,
    'Receiver dock closed',
  );
  controls.destroy();
});

test('the spectrum row and the voice tune event drive the dock; tabs stay outside', (t) => {
  const { controls, elements, calls, layerState } = fixture(t, {
    enabled: true,
    selected: KIWI,
  });
  controls.connect();
  elements._webReceiversSpecFrom.value = '10000';
  elements._webReceiversSpecTo.value = '15000';
  elements._webReceiversSpecBtn.dispatchEvent(new Event('click'));
  assert.deepEqual(
    calls.find((call) => call[0] === 'spectrum'),
    [
      'spectrum',
      { receiverId: 'aaaaaaaaaaaa', lowHz: 10_000_000, highHz: 15_000_000 },
    ],
  );
  assert.equal(
    elements._webReceiversDockLabel.textContent,
    'Kiwi Arvika · spectrum 10,000–15,000 kHz · muted',
  );

  layerState.lastTune = {
    kind: 'tune',
    receiverName: 'Kiwi Arvika',
    frequencyLabel: '7,055 kHz',
    mode: 'lsb',
  };
  document.dispatchEvent(
    new CustomEvent('gev:web-receiver-tune', {
      detail: {
        url: 'http://sa4bna.hopto.org:8073/?f=7055lsbz10',
        openIn: 'tab',
      },
    }),
  );
  assert.equal(
    elements._webReceiversStatus.textContent,
    'Opened Kiwi Arvika · 7,055 kHz LSB in a new tab',
  );
  document.dispatchEvent(
    new CustomEvent('gev:web-receiver-tune', {
      detail: {
        url: 'http://sa4bna.hopto.org:8073/?f=7055lsbz10',
        openIn: 'dock',
      },
    }),
  );
  assert.equal(
    elements._webReceiversFrame.getAttribute('src'),
    'http://sa4bna.hopto.org:8073/?f=7055lsbz10',
  );
  // Disabling the layer closes the dock without a "closed" message.
  layerState.enabled = false;
  layer_render(controls, layerState);
  assert.equal(elements._webReceiversDock.hidden, true);
  assert.equal(elements._webReceiversStatus.textContent, 'Web receivers off');
  controls.destroy();
});

function layer_render(controls, state) {
  controls._renderState(state);
}

test('a plain-http receiver cannot embed on an https origin: the dock says so', (t) => {
  const { controls, elements } = fixture(t, {
    enabled: true,
    selected: KIWI,
    protocol: 'https:',
  });
  controls.connect();
  elements._webReceiversFreq.value = '14233';
  elements._webReceiversTuneBtn.dispatchEvent(new Event('click'));
  assert.equal(elements._webReceiversDock.hidden, false);
  assert.equal(elements._webReceiversFrame.hidden, true);
  assert.equal(elements._webReceiversFrame.getAttribute('src'), null);
  assert.equal(elements._webReceiversDockNote.hidden, false);
  assert.match(elements._webReceiversDockNote.textContent, /plain http/);
  assert.match(
    elements._webReceiversStatus.textContent,
    /open it in a new tab/,
  );
  controls.destroy();
});
