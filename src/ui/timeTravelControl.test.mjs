import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTimeTravelControl,
  formatClock,
  formatOffset,
} from './timeTravelControl.js';

class FakeElement extends EventTarget {
  constructor(doc, tag) {
    super();
    this.doc = doc;
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this._id = '';
  }
  get id() {
    return this._id;
  }
  set id(value) {
    if (this._id) this.doc.registry.delete(this._id);
    this._id = value;
    if (value) this.doc.registry.set(value, this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
    const drop = (node) => {
      if (node._id) node.doc.registry.delete(node._id);
      node.children.forEach(drop);
    };
    drop(this);
  }
}
function createFakeDocument({ dock = true } = {}) {
  const doc = {
    registry: new Map(),
    createElement(tag) {
      return new FakeElement(doc, tag);
    },
    getElementById(id) {
      return doc.registry.get(id) || null;
    },
  };
  doc.body = new FakeElement(doc, 'body');
  if (dock) {
    doc.dock = new FakeElement(doc, 'div');
    doc.dock.id = 'command-dock';
    doc.body.appendChild(doc.dock);
  }
  return doc;
}
function createFakeTimeTravel() {
  const listeners = new Set();
  const state = {
    mode: 'live',
    displayTimeMs: NaN,
    offsetMs: 0,
    rate: 1,
    oldestT: 1_000_000,
    newestT: 1_900_000,
  };
  const calls = [];
  const emit = (patch = {}) => {
    Object.assign(state, patch);
    for (const listener of listeners) listener({ ...state }, 'test');
  };
  return {
    calls,
    emit,
    state: () => ({ ...state }),
    rewind: (offset) => {
      calls.push(['rewind', offset]);
      return state.accept !== false;
    },
    seekTo: (t) => {
      calls.push(['seekTo', t]);
      return true;
    },
    setRate: (rate) => {
      calls.push(['setRate', rate]);
      return rate;
    },
    resumeLive: () => {
      calls.push(['resumeLive']);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

test('labels format offsets and clocks', () => {
  assert.equal(formatOffset(-452_000), 'LIVE −07:32');
  assert.equal(formatOffset(-3_725_000), 'LIVE −1:02:05');
  assert.equal(formatOffset(NaN), 'LIVE');
  assert.equal(formatClock(NaN), '--:--:--');
  const noon = new Date(2026, 0, 1, 12, 3, 4).getTime();
  assert.equal(formatClock(noon), '12:03:04');
});

test('mounts in the dock, shows the scrubber only while rewound, and drives the controller', () => {
  const doc = createFakeDocument();
  const timeTravel = createFakeTimeTravel();
  const control = createTimeTravelControl({ timeTravel, documentRef: doc });
  assert.equal(
    control.root.parent,
    doc.dock,
    'button lives in the command dock',
  );
  assert.equal(control.scrubber.parent, doc.body);
  assert.equal(control.scrubber.hidden, true);
  assert.equal(
    doc.getElementById('gev-time-travel-rewind'),
    control.rewindButton,
  );

  control.rewindButton.dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls, [['rewind', -600_000]]);

  timeTravel.emit({
    mode: 'rewind',
    displayTimeMs: 1_450_000,
    offsetMs: -452_000,
    rate: 4,
  });
  assert.equal(control.scrubber.hidden, false);
  assert.equal(control.root.dataset.mode, 'rewind');
  assert.equal(control.offsetOut.textContent, 'LIVE −07:32');
  assert.equal(control.clock.textContent, formatClock(1_450_000));
  assert.equal(control.range.value, '500');
  assert.equal(control.rateButtons.get(4).getAttribute('aria-pressed'), 'true');
  assert.equal(
    control.rateButtons.get(1).getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(control.playButton.textContent, '⏸');

  // A second press while rewound steps another ten minutes back.
  timeTravel.calls.length = 0;
  control.rewindButton.dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls, [['seekTo', 1_450_000 - 600_000]]);

  timeTravel.calls.length = 0;
  control.playButton.dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls, [['setRate', 0]]);
  timeTravel.emit({ rate: 0 });
  assert.equal(control.playButton.textContent, '▶');
  control.playButton.dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls.at(-1), ['setRate', 1]);

  timeTravel.calls.length = 0;
  control.rateButtons.get(16).dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls, [['setRate', 16]]);

  timeTravel.calls.length = 0;
  timeTravel.emit({ rate: 1 });
  control.range.value = '250';
  control.range.dispatchEvent(new Event('input'));
  assert.deepEqual(timeTravel.calls, [
    ['setRate', 0],
    ['seekTo', 1_000_000 + 0.25 * 900_000],
  ]);

  timeTravel.calls.length = 0;
  control.liveButton.dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls, [['resumeLive']]);
  timeTravel.emit({ mode: 'live', displayTimeMs: NaN, offsetMs: 0 });
  assert.equal(control.scrubber.hidden, true);

  control.destroy();
  assert.equal(timeTravel.listenerCount, 0);
  assert.equal(doc.getElementById('gev-time-travel'), null);
  assert.equal(doc.getElementById('gev-time-travel-scrubber'), null);
  assert.equal(doc.dock.children.length, 0);
  timeTravel.calls.length = 0;
  control.rewindButton.dispatchEvent(new Event('click'));
  assert.deepEqual(timeTravel.calls, [], 'destroyed control is inert');
});

test('a refused rewind reports through notify and remounting replaces the old nodes', () => {
  const doc = createFakeDocument({ dock: false });
  const timeTravel = createFakeTimeTravel();
  timeTravel.emit({ accept: false });
  const notices = [];
  const first = createTimeTravelControl({
    timeTravel,
    documentRef: doc,
    notify: (message) => notices.push(message),
  });
  assert.equal(
    first.root.parent,
    doc.body,
    'falls back to body without a dock',
  );
  first.rewindButton.dispatchEvent(new Event('click'));
  assert.equal(notices.length, 1);
  const second = createTimeTravelControl({ timeTravel, documentRef: doc });
  assert.equal(first.root.parent, null, 'previous mount removed');
  assert.equal(doc.getElementById('gev-time-travel'), second.root);
  second.destroy();
  first.destroy();
});
