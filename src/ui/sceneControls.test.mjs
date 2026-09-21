import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateChannel } from '../app/stateChannel.js';
import { SceneControls } from './sceneControls.js';
import { SceneDirector } from '../scenes/director.js';

function fixture() {
  class Element extends EventTarget {
    constructor() {
      super();
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.value = '';
      this._text = '';
      const classes = new Set();
      this.classList = {
        toggle(name, active) {
          if (active) classes.add(name);
          else classes.delete(name);
        },
        contains: (name) => classes.has(name),
      };
    }
    appendChild(element) {
      this.children.push(element);
      element.parentNode = this;
    }
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    }
    remove() {
      if (this.parentNode)
        this.parentNode.children = this.parentNode.children.filter(
          (node) => node !== this,
        );
    }
    setAttribute(name, value) {
      this[name] = value;
    }
    focus() {}
    select() {}
    set textContent(value) {
      this._text = value;
      this.children = [];
    }
    get textContent() {
      return (
        this._text + this.children.map((node) => node.textContent).join('')
      );
    }
    click() {
      this.dispatchEvent(new Event('click'));
    }
  }
  const saved = { document: globalThis.document, window: globalThis.window };
  const document = Object.assign(new EventTarget(), {
    createElement: () => new Element(),
    body: new Element(),
  });
  globalThis.document = document;
  globalThis.window = { prompt: () => 'Renamed' };
  const elements = Object.fromEntries(
    [
      'panel',
      'select',
      'new',
      'delete',
      'capture',
      'update',
      'shots',
      'start',
      'stop',
      'next',
      'export',
      'import',
      'file',
      'download',
      'status',
      'progress',
      'runtime',
    ].map((name) => [name, new Element()]),
  );
  const state = {
    scenes: [
      {
        id: 'scene-a',
        title: '<Scene A>',
        shots: [
          {
            id: 'shot-a',
            title: '<Shot A>',
            durationSec: 4,
            holdSec: 0.9,
            visual: { style: 'normal' },
          },
        ],
      },
    ],
    selectedSceneId: 'scene-a',
    selectedShotId: 'shot-a',
    running: false,
    hasRun: false,
  };
  const calls = [];
  const actions = Object.fromEntries(
    [
      'selectScene',
      'selectShot',
      'renameShot',
      'create',
      'deleteScene',
      'capture',
      'update',
      'start',
      'stop',
      'next',
      'export',
      'import',
      'download',
      'load',
      'deleteShot',
    ].map((name) => [
      name,
      (...args) => {
        calls.push([name, ...args]);
      },
    ]),
  );
  const owner = new SceneControls({ read: () => state, actions, elements });
  return {
    owner,
    state,
    actions,
    elements,
    calls,
    document,
    restore() {
      owner.destroy();
      Object.assign(globalThis, saved);
    },
  };
}

test('Scene controls render the supplied selection and running/download states', () => {
  const f = fixture();
  try {
    assert.equal(f.elements.select.children[0].textContent, '<Scene A>');
    assert.equal(f.elements.select.value, 'scene-a');
    assert.equal(
      f.elements.shots.children[0].children[0].children[0].textContent,
      '<Shot A>',
    );
    assert.equal(f.elements.stop.disabled, true);
    assert.equal(f.elements.download.disabled, true);
    f.state.hasRun = true;
    f.owner.setButtons(true);
    assert.equal(f.elements.start.disabled, true);
    assert.equal(f.elements.capture.disabled, true);
    assert.equal(f.elements.stop.disabled, false);
    assert.equal(f.elements.download.disabled, false);
    assert.equal(f.elements.panel.classList.contains('running'), true);
    f.owner.setProgress(2);
    assert.equal(f.elements.progress.style.width, '100%');
    f.owner.setProgress(-1);
    assert.equal(f.elements.progress.textContent, '0%');
  } finally {
    f.restore();
  }
});

test('Scene controls dispatch explicit actions and revoke replaced shot-row listeners', () => {
  const f = fixture();
  try {
    const row = f.elements.shots.children[0];
    const label = row.children[0].children[0];
    const load = row.children[0].children[1].children[0];
    f.elements.capture.click();
    f.elements.start.click();
    label.click();
    label.dispatchEvent(new Event('dblclick'));
    label.children[0].value = 'Renamed';
    label.children[0].dispatchEvent(new Event('blur'));
    load.click();
    assert.deepEqual(f.calls, [
      ['capture'],
      ['start', 'scene-a'],
      ['selectShot', 'shot-a'],
      ['renameShot', 'scene-a', 'shot-a', 'Renamed'],
      ['load', 'scene-a', 'shot-a'],
    ]);
    f.owner.renderShotList();
    label.click();
    load.click();
    assert.equal(f.calls.length, 5);
    f.elements.shots.children[0].children[0].children[1].children[0].click();
    assert.equal(f.calls.length, 6);
  } finally {
    f.restore();
  }
});

test('Scene Escape and recording presentation follow playback and release on destruction', () => {
  const f = fixture();
  const escape = () =>
    f.document.dispatchEvent(
      Object.assign(new Event('keydown'), { key: 'Escape' }),
    );
  try {
    escape();
    assert.deepEqual(f.calls, []);
    f.state.running = true;
    f.owner.setPlaybackActive(true);
    f.owner.setPlaybackKeyboardEnabled(true);
    f.owner.updateRuntime('Scene A / Shot A');
    escape();
    assert.deepEqual(f.calls, [['stop', 'Stopped (Esc)']]);
    f.owner.destroy();
    f.owner.destroy();
    f.owner.setPlaybackKeyboardEnabled(true);
    escape();
    f.elements.capture.click();
    f.owner.run('capture');
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.document.body.classList.contains('scene-playback-mode'),
      false,
    );
    assert.equal(f.elements.runtime.textContent, '');
    assert.equal(f.owner.removers.length, 0);
    assert.equal(f.owner.rowRemovers.length, 0);
  } finally {
    f.restore();
  }
});

test('a file import finishing after disposal cannot clear the retained file control', async () => {
  const f = fixture();
  try {
    let finish;
    f.actions.import = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    f.elements.file.files = [{ name: 'project.json' }];
    f.elements.file.value = 'project.json';
    f.elements.file.dispatchEvent(new Event('change'));
    f.owner.destroy();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.elements.file.value, 'project.json');
    assert.equal(f.elements.status.textContent, 'Ready');
  } finally {
    f.restore();
  }
});

test('Scene action failures are visible only while that action still owns presentation', async () => {
  const f = fixture();
  try {
    let reject;
    f.actions.load = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    let pending = f.owner.run('load', 'scene-a', 'shot-a');
    reject(new Error('unavailable'));
    await pending;
    assert.equal(f.elements.status.textContent, 'Scene action failed');
    pending = f.owner.run('load', 'scene-a', 'shot-a');
    f.owner.run('selectShot', 'shot-a');
    f.owner.updateStatus('Current selection');
    reject(new Error('obsolete'));
    await pending;
    assert.equal(f.elements.status.textContent, 'Current selection');
    pending = f.owner.run('load', 'scene-a', 'shot-a');
    f.owner.destroy();
    reject(new Error('disposed'));
    await pending;
    assert.equal(f.elements.status.textContent, 'Current selection');
  } finally {
    f.restore();
  }
});

test('creation and deletion prompts precede their model actions and remain inert after disposal', () => {
  const f = fixture();
  try {
    let prompts = 0;
    window.prompt = () => {
      prompts++;
      return null;
    };
    window.confirm = () => {
      prompts++;
      return false;
    };
    f.elements.new.click();
    f.elements.delete.click();
    f.owner.deleteShot('scene-a', 'shot-a');
    assert.deepEqual(f.calls, []);
    window.prompt = () => {
      prompts++;
      return 'New title';
    };
    window.confirm = () => {
      prompts++;
      return true;
    };
    f.elements.new.click();
    f.elements.delete.click();
    f.owner.deleteShot('scene-a', 'shot-a');
    assert.deepEqual(f.calls, [
      ['create', 'New title'],
      ['deleteScene'],
      ['deleteShot', 'scene-a', 'shot-a'],
    ]);
    f.owner.destroy();
    f.owner.createScene();
    f.owner.deleteSelectedScene();
    f.owner.deleteShot('scene-a', 'shot-a');
    assert.equal(prompts, 6);
  } finally {
    f.restore();
  }
});

test('the real director preserves a selected shot label for the following double-click', async () => {
  const f = fixture();
  const previousStorage = globalThis.localStorage;
  let director;
  try {
    f.owner.destroy();
    const ids = {
      'scene-panel': 'panel',
      'scene-select': 'select',
      'scene-new-btn': 'new',
      'scene-delete-btn': 'delete',
      'scene-capture-btn': 'capture',
      'scene-update-shot-btn': 'update',
      'scene-shot-list': 'shots',
      'scene-start-btn': 'start',
      'scene-stop-btn': 'stop',
      'scene-next-btn': 'next',
      'scene-export-btn': 'export',
      'scene-import-btn': 'import',
      'scene-import-file': 'file',
      'scene-download-btn': 'download',
      'scene-status': 'status',
      'scene-progress-fill': 'progress',
      'scene-runtime': 'runtime',
    };
    f.document.getElementById = (id) => f.elements[ids[id]] || null;
    globalThis.localStorage = {
      getItem: () => JSON.stringify({ version: 3, scenes: f.state.scenes }),
      setItem() {},
    };
    director = new SceneDirector({ camera: { cancelFlight() {} } }, {}, {});
    const label = f.elements.shots.children[0].children[0].children[0];
    label.click();
    assert.equal(f.elements.shots.children[0].children[0].children[0], label);
    label.dispatchEvent(new Event('dblclick'));
    label.children[0].value = 'Renamed';
    label.children[0].dispatchEvent(new Event('blur'));
    assert.equal(director._getSelectedScene().shots[0].title, 'Renamed');
  } finally {
    await director?.destroy();
    globalThis.localStorage = previousStorage;
    f.restore();
  }
});

test('inline shot names save on Enter, cancel on Escape, and reject blank names', () => {
  const f = fixture();
  const key = (name) => Object.assign(new Event('keydown'), { key: name });
  try {
    const label = f.elements.shots.children[0].children[0].children[0];
    for (const [value, commitKey] of [
      ['Cancelled', 'Escape'],
      ['   ', 'Enter'],
      [' New name ', 'Enter'],
    ]) {
      label.dispatchEvent(new Event('dblclick'));
      const input = label.children[0];
      input.value = value;
      input.dispatchEvent(key(commitKey));
      input.dispatchEvent(new Event('blur'));
    }
    assert.deepEqual(f.calls, [
      ['renameShot', 'scene-a', 'shot-a', 'New name'],
    ]);
    assert.equal(
      label.textContent,
      '<Shot A>',
      'the model owns the next render',
    );
  } finally {
    f.restore();
  }
});

test('Scene controls consume current state, preserve rows on progress, and unsubscribe on destruction', () => {
  const f = fixture();
  try {
    f.owner.destroy();
    Object.assign(f.state, {
      status: 'Ready to resume',
      progress: 0.25,
      runtime: '',
      playbackActive: false,
      keyboardEnabled: false,
    });
    const channel = createStateChannel(() => f.state);
    const owner = new SceneControls({
      read: () => f.state,
      actions: f.actions,
      elements: f.elements,
      subscribe: (listener) => channel.subscribe(listener),
    });
    assert.equal(f.elements.status.textContent, 'Ready to resume');
    const row = f.elements.shots.children[0];
    f.state.progress = 0.5;
    channel.publish({ type: 'progress-changed' });
    assert.equal(f.elements.shots.children[0], row);
    f.state.status = 'Project exported';
    channel.publish({ type: 'project-exported' });
    assert.equal(f.elements.status.textContent, 'Project exported');
    owner.destroy();
    f.state.status = 'Late';
    channel.publish({ type: 'status-changed' });
    assert.equal(f.elements.status.textContent, 'Project exported');
    assert.equal(owner.unsubscribe, null);
    channel.destroy();
  } finally {
    f.restore();
  }
});
