import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHudLockSound,
  applyHudPrimaryColor,
  applyHudSecondaryColor,
  applyHudTarget,
  bindHudAppearanceControls,
  hexToRgba,
  HUD_TARGET_EVENT,
  normalizeHexColor,
} from './hudAppearance.js';

function fakeStyle(initial = {}) {
  const props = { ...initial };
  return {
    props,
    setProperty: (name, value) => {
      props[name] = value;
    },
    getPropertyValue: (name) => props[name] ?? '',
  };
}

function fakeControl(dataset = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset,
    value: '',
    attributes: {},
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire(type) {
      listeners.get(type)?.();
    },
    listeners,
  };
}

function fakeDocument({
  themeAccent = ' #00d4ff',
  secondary = '#ffd38a',
} = {}) {
  const style = fakeStyle();
  const sheet = { '--accent': themeAccent, '--secondary-accent': secondary };
  const events = [];
  const observers = [];
  const documentElement = { dataset: {}, style };
  const buttons = [
    fakeControl({ hudTarget: 'default' }),
    fakeControl({ hudTarget: 'lock' }),
  ];
  const soundSelect = fakeControl();
  const primary = fakeControl();
  const secondaryInput = fakeControl();
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  class MutationObserver {
    constructor(fn) {
      this.fn = fn;
      observers.push(this);
    }
    observe(target, options) {
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const doc = {
    documentElement,
    defaultView: {
      CustomEvent,
      MutationObserver,
      dispatchEvent: (event) => events.push(event),
      getComputedStyle: () => ({
        getPropertyValue: (name) => style.props[name] ?? sheet[name] ?? '',
      }),
    },
    querySelectorAll: (selector) =>
      ({
        '#hud-target-seg [data-hud-target]': buttons,
      })[selector] ?? [],
    getElementById: (id) =>
      ({
        'hud-primary-color': primary,
        'hud-secondary-color': secondaryInput,
        'hud-lock-sound-select': soundSelect,
      })[id] ?? null,
  };
  return {
    doc,
    style,
    sheet,
    events,
    observers,
    buttons,
    soundSelect,
    primary,
    secondaryInput,
  };
}

test('colour helpers normalise hex and derive rgba', () => {
  assert.equal(normalizeHexColor(' #0DF '), '#00ddff');
  assert.equal(normalizeHexColor('#FFD38A'), '#ffd38a');
  assert.equal(normalizeHexColor('red'), null);
  assert.equal(hexToRgba('#00d4ff', 0.4), 'rgba(0, 212, 255, 0.4)');
});

test('primary writes --accent and its companions; secondary writes --secondary-accent', () => {
  const { doc, style } = fakeDocument();
  assert.equal(
    applyHudPrimaryColor('#ff0000', { documentRef: doc }),
    '#ff0000',
  );
  assert.equal(style.props['--accent'], '#ff0000');
  assert.equal(style.props['--accent-dim'], 'rgba(255, 0, 0, 0.15)');
  assert.equal(style.props['--accent-glow'], 'rgba(255, 0, 0, 0.4)');
  assert.equal(applyHudPrimaryColor('nope', { documentRef: doc }), null);
  assert.equal(
    applyHudSecondaryColor('#112233', { documentRef: doc }),
    '#112233',
  );
  assert.equal(style.props['--secondary-accent'], '#112233');
});

test('target mode is stored on the root and announced', () => {
  const { doc, events } = fakeDocument();
  assert.equal(applyHudTarget('lock', { documentRef: doc }), 'lock');
  assert.equal(doc.documentElement.dataset.hudTarget, 'lock');
  assert.equal(applyHudTarget('bogus', { documentRef: doc }), 'default');
  assert.deepEqual(
    events.map((e) => [e.type, e.detail.mode]),
    [
      [HUD_TARGET_EVENT, 'lock'],
      [HUD_TARGET_EVENT, 'default'],
    ],
  );
});

test('the HUD section starts on Default with the theme colours and applies edits', () => {
  const fake = fakeDocument();
  let changes = 0;
  const bound = bindHudAppearanceControls({
    documentRef: fake.doc,
    onChange: () => changes++,
  });
  const [defaultBtn, lockBtn] = fake.buttons;
  assert.equal(fake.doc.documentElement.dataset.hudTarget, 'default');
  assert.ok(defaultBtn.classList.contains('active'));
  assert.equal(lockBtn.attributes['aria-checked'], 'false');
  assert.equal(fake.primary.value, '#00d4ff', 'primary starts at --accent');
  assert.equal(fake.secondaryInput.value, '#ffd38a');

  lockBtn.fire('click');
  assert.equal(fake.doc.documentElement.dataset.hudTarget, 'lock');
  assert.ok(lockBtn.classList.contains('active'));
  assert.ok(!defaultBtn.classList.contains('active'));

  // A theme switch moves the picker while the operator has not chosen one.
  fake.sheet['--accent'] = '#e9f0f1';
  fake.observers[0].fn();
  assert.equal(fake.primary.value, '#e9f0f1');

  fake.primary.value = '#33cc66';
  fake.primary.fire('input');
  assert.equal(fake.style.props['--accent'], '#33cc66');
  fake.sheet['--accent'] = '#00d4ff';
  fake.observers[0].fn();
  assert.equal(fake.primary.value, '#33cc66', 'an override sticks');

  fake.secondaryInput.value = '#aa00ff';
  fake.secondaryInput.fire('input');
  assert.equal(fake.style.props['--secondary-accent'], '#aa00ff');
  assert.equal(changes, 3);

  assert.equal(fake.doc.documentElement.dataset.hudLockSound, 'hud-lock');
  assert.equal(fake.soundSelect.value, 'hud-lock');
  fake.soundSelect.value = 'sci-fi-click';
  fake.soundSelect.fire('change');
  assert.equal(fake.doc.documentElement.dataset.hudLockSound, 'sci-fi-click');
  fake.soundSelect.value = 'none';
  fake.soundSelect.fire('change');
  assert.equal(fake.doc.documentElement.dataset.hudLockSound, 'none');
  assert.equal(changes, 5);

  bound.destroy();
  assert.equal(fake.primary.listeners.size, 0);
  assert.ok(fake.observers[0].disconnected);
});

test('target sound is stored on the root and defaults to hud-lock', () => {
  const { doc } = fakeDocument();
  assert.equal(
    applyHudLockSound('sci-fi-click', { documentRef: doc }),
    'sci-fi-click',
  );
  assert.equal(doc.documentElement.dataset.hudLockSound, 'sci-fi-click');
  assert.equal(applyHudLockSound('none', { documentRef: doc }), 'none');
  assert.equal(applyHudLockSound('loud', { documentRef: doc }), 'hud-lock');
});
