import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { createStateChannel } from '../app/stateChannel.js';
import { setLocale } from '../i18n/index.js';
import { installVueDom } from '../testSupport/vueDom.mjs';

// Vue binds the document when it loads, so it loads after the DOM.
let createApp;
let nextTick;
let SceneControls;
let SceneDirector;
let LayerPanelsView;
let applicationPinia;
let useSceneStore;

let uninstallDom;
before(async () => {
  uninstallDom = installVueDom();
  ({ createApp, nextTick } = await import('vue'));
  ({ SceneControls } = await import('./sceneControls.js'));
  ({ SceneDirector } = await import('../scenes/director.js'));
  ({ applicationPinia } = await import('./vueRuntime.js'));
  ({ useSceneStore } = await import('./stores/scenes.js'));
  LayerPanelsView = (await import('./views/LayerPanelsView.vue')).default;
});
after(() => uninstallDom());

/** Mount the real Scene panel view and an owner over it. */
function fixture() {
  const saved = { prompt: window.prompt, confirm: window.confirm };
  document.body.innerHTML =
    '<div id="layer-panels-host"></div><div id="scene-runtime"></div>';
  const view = createApp(LayerPanelsView).use(applicationPinia());
  view.mount(document.getElementById('layer-panels-host'));
  window.prompt = () => 'Renamed';
  const byId = (id) => document.getElementById(id);
  const elements = {
    panel: byId('scene-panel'),
    select: byId('scene-select'),
    new: byId('scene-new-btn'),
    delete: byId('scene-delete-btn'),
    capture: byId('scene-capture-btn'),
    update: byId('scene-update-shot-btn'),
    start: byId('scene-start-btn'),
    stop: byId('scene-stop-btn'),
    next: byId('scene-next-btn'),
    export: byId('scene-export-btn'),
    import: byId('scene-import-btn'),
    file: byId('scene-import-file'),
    download: byId('scene-download-btn'),
    status: byId('scene-status'),
    progress: byId('scene-progress-fill'),
    runtime: byId('scene-runtime'),
    shots: byId('scene-shot-list'),
  };
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
  const owner = new SceneControls({ read: () => state, actions });
  return {
    owner,
    state,
    actions,
    elements,
    calls,
    document,
    /** The first shot row's label, once the view has rendered. */
    label: () => elements.shots.children[0]?.children[0].children[0],
    restore() {
      owner.destroy();
      view.unmount();
      Object.assign(window, saved);
    },
  };
}

test('Scene controls render the supplied selection and running/download states', async () => {
  const f = fixture();
  try {
    await nextTick();
    assert.equal(f.elements.select.children[0].textContent, '<Scene A>');
    assert.equal(f.elements.select.value, 'scene-a');
    assert.equal(f.label().textContent, '<Shot A>');
    assert.equal(
      f.elements.shots.children[0].children[1].textContent,
      'NORMAL · OFF · 4.0s + 0.9s',
    );
    await nextTick();
    assert.equal(f.elements.stop.disabled, true);
    assert.equal(f.elements.download.disabled, true);
    f.state.hasRun = true;
    f.owner.setButtons(true);
    await nextTick();
    assert.equal(f.elements.start.disabled, true);
    assert.equal(f.elements.capture.disabled, true);
    assert.equal(f.elements.stop.disabled, false);
    assert.equal(f.elements.download.disabled, false);
    assert.equal(f.elements.panel.classList.contains('running'), true);
    f.owner.setProgress(2);
    await nextTick();
    assert.equal(f.elements.progress.style.width, '100%');
    f.owner.setProgress(-1);
    await nextTick();
    assert.equal(f.elements.progress.textContent, '0%');
  } finally {
    f.restore();
  }
});

test('Authoring disables idle actions that would do nothing', async () => {
  const f = fixture();
  try {
    await nextTick();
    assert.equal(f.elements.start.textContent, 'PLAY');
    assert.equal(f.elements.start.disabled, false);
    assert.equal(f.elements.update.disabled, false);
    assert.equal(f.elements.panel.classList.contains('has-shots'), true);

    f.state.selectedShotId = null;
    f.owner.setButtons(false);
    await nextTick();
    assert.equal(f.elements.update.disabled, true);
    assert.equal(f.elements.start.disabled, false);

    // PLAY and NEXT run on into the following scenes, so an empty selected
    // scene beside one with shots keeps them available.
    f.state.scenes[0].shots = [];
    f.state.scenes.push({ id: 'scene-b', title: 'B', shots: [{ id: 'b1' }] });
    f.owner.setButtons(false);
    await nextTick();
    assert.equal(f.elements.start.disabled, false);
    assert.equal(f.elements.next.disabled, false);
    assert.equal(f.elements.update.disabled, true);

    f.state.scenes.pop();
    f.owner.setButtons(false);
    await nextTick();
    assert.equal(f.elements.start.disabled, true);
    assert.equal(f.elements.next.disabled, true);
    assert.equal(f.elements.capture.disabled, false);
    assert.equal(f.elements.panel.classList.contains('has-shots'), false);

    f.state.scenes = [];
    f.state.selectedSceneId = null;
    f.owner.setButtons(false);
    await nextTick();
    assert.equal(f.elements.delete.disabled, true);
    assert.equal(f.elements.capture.disabled, true);
    assert.equal(f.elements.new.disabled, false);
  } finally {
    f.restore();
  }
});

test('Scene controls dispatch panel and shot-row actions, and rows outlive republishing', async () => {
  const f = fixture();
  try {
    await nextTick();
    const row = f.elements.shots.children[0];
    const label = f.label();
    const load = row.children[0].children[1].children[0];
    f.elements.capture.click();
    f.elements.start.click();
    label.click();
    label.dispatchEvent(new Event('dblclick'));
    await nextTick();
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
    await nextTick();
    assertSameNode(f.elements.shots.children[0], row);
    // An owner destroyed after a newer one attached leaves the newer list.
    const newer = new SceneControls({
      read: () => f.state,
      actions: f.actions,
    });
    f.owner.destroy();
    await nextTick();
    f.label().click();
    assert.deepEqual(f.calls.at(-1), ['selectShot', 'shot-a']);
    newer.destroy();
    await nextTick();
    assert.equal(f.elements.shots.children.length, 0);
  } finally {
    f.restore();
  }
});

test('Scene Escape and recording presentation follow playback and release on destruction', async () => {
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
    // The Context view renders the chip from the store.
    const panel = () => useSceneStore(applicationPinia()).panel;
    assert.equal(panel().runtime, 'Scene A / Shot A');
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
    assert.equal(panel().runtime, '');
    assert.equal(panel().hasShots, false);
  } finally {
    f.restore();
  }
});

test('a file import finishing after disposal cannot clear the retained file control', async () => {
  const f = fixture();
  try {
    let finish;
    let imported;
    f.actions.import = (file) =>
      new Promise((resolve) => {
        imported = file;
        finish = resolve;
      });
    // A file input's files and value are read-only to scripts.
    Object.defineProperty(f.elements.file, 'files', {
      value: [{ name: 'project.json' }],
    });
    Object.defineProperty(f.elements.file, 'value', {
      value: 'project.json',
      writable: true,
    });
    f.elements.file.dispatchEvent(new Event('change'));
    assert.deepEqual(imported, { name: 'project.json' });
    f.owner.destroy();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    // The chooser is left as it was once its owner is gone.
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
    await nextTick();
    assert.equal(f.elements.status.textContent, 'Scene action failed');
    pending = f.owner.run('load', 'scene-a', 'shot-a');
    f.owner.run('selectShot', 'shot-a');
    f.owner.updateStatus('Current selection');
    reject(new Error('obsolete'));
    await pending;
    await nextTick();
    assert.equal(f.elements.status.textContent, 'Current selection');
    pending = f.owner.run('load', 'scene-a', 'shot-a');
    f.owner.destroy();
    reject(new Error('disposed'));
    await pending;
    await nextTick();
    assert.equal(f.elements.status.textContent, 'Current selection');
  } finally {
    f.restore();
  }
});

test('creation and deletion prompts precede their model actions and remain inert after disposal', async () => {
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
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => JSON.stringify({ version: 3, scenes: f.state.scenes }),
        setItem() {},
      },
    });
    director = new SceneDirector({ camera: { cancelFlight() {} } }, {}, {});
    await nextTick();
    const label = f.label();
    label.click();
    await nextTick();
    assert.equal(f.label(), label);
    label.dispatchEvent(new Event('dblclick'));
    await nextTick();
    label.children[0].value = 'Renamed';
    label.children[0].dispatchEvent(new Event('blur'));
    assert.equal(director._getSelectedScene().shots[0].title, 'Renamed');
  } finally {
    await director?.destroy();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousStorage,
    });
    f.restore();
  }
});

test('inline shot names save on Enter, cancel on Escape, and reject blank names', async () => {
  const f = fixture();
  const key = (name) => new KeyboardEvent('keydown', { key: name });
  try {
    await nextTick();
    const label = f.label();
    for (const [value, commitKey] of [
      ['Cancelled', 'Escape'],
      ['   ', 'Enter'],
      [' New name ', 'Enter'],
    ]) {
      label.dispatchEvent(new Event('dblclick'));
      await nextTick();
      const input = label.children[0];
      assertSameNode(document.activeElement, input);
      input.value = value;
      input.dispatchEvent(key(commitKey));
      input.dispatchEvent(new Event('blur'));
      await nextTick();
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

test('a rename keeps typed text across republishing and ends with its scene', async () => {
  const f = fixture();
  try {
    await nextTick();
    const label = f.label();
    label.dispatchEvent(new Event('dblclick'));
    await nextTick();
    label.children[0].value = 'Typing';
    f.owner.renderShotList();
    await nextTick();
    assert.equal(label.children[0].value, 'Typing');
    f.state.scenes.push({
      id: 'scene-b',
      title: 'B',
      shots: [{ id: 'b1', title: 'B1', durationSec: 1, holdSec: 1 }],
    });
    f.state.selectedSceneId = 'scene-b';
    f.owner.renderShotList();
    await nextTick();
    f.state.selectedSceneId = 'scene-a';
    f.owner.renderShotList();
    await nextTick();
    assert.equal(f.label().children.length, 0);
    assert.equal(f.label().textContent, '<Shot A>');
  } finally {
    f.restore();
  }
});

test('the scene select follows option renders, as before', async () => {
  const f = fixture();
  try {
    await nextTick();
    f.state.scenes.push({ id: 'scene-b', title: 'B', shots: [] });
    f.owner.renderSceneSelect();
    await nextTick();
    f.state.selectedSceneId = 'scene-b';
    f.owner.renderShotList();
    await nextTick();
    assert.equal(f.elements.select.value, 'scene-a');
    f.owner.renderSceneSelect();
    await nextTick();
    assert.equal(f.elements.select.value, 'scene-b');
  } finally {
    f.restore();
  }
});

test('an option render restores the published scene after a local pick', async () => {
  const f = fixture();
  try {
    f.state.scenes.push({ id: 'scene-b', title: 'B', shots: [] });
    f.owner.renderSceneSelect();
    await nextTick();
    assert.equal(f.elements.select.value, 'scene-a');
    // The person picks B; the owner re-renders the shot list only.
    f.elements.select.value = 'scene-b';
    f.owner.renderShotList();
    await nextTick();
    // Something reloads A and renders the options with the same choice.
    f.owner.renderSceneSelect();
    await nextTick();
    assert.equal(f.elements.select.value, 'scene-a');
  } finally {
    f.restore();
  }
});

test('Scene controls consume current state, preserve rows on progress, and unsubscribe on destruction', async () => {
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
      subscribe: (listener) => channel.subscribe(listener),
    });
    await nextTick();
    assert.equal(f.elements.status.textContent, 'Ready to resume');
    await nextTick();
    const row = f.elements.shots.children[0];
    f.state.progress = 0.5;
    channel.publish({ type: 'progress-changed' });
    await nextTick();
    assertSameNode(f.elements.shots.children[0], row);
    f.state.status = 'Project exported';
    channel.publish({ type: 'project-exported' });
    await nextTick();
    assert.equal(f.elements.status.textContent, 'Project exported');
    owner.destroy();
    f.state.status = 'Late';
    channel.publish({ type: 'status-changed' });
    await nextTick();
    assert.equal(f.elements.status.textContent, 'Project exported');
    assert.equal(owner.unsubscribe, null);
    channel.destroy();
  } finally {
    f.restore();
  }
});

test('Authoring refreshes idle buttons from published changes', async () => {
  const f = fixture();
  try {
    f.owner.destroy();
    const channel = createStateChannel(() => f.state);
    const owner = new SceneControls({
      read: () => f.state,
      actions: f.actions,
      subscribe: (listener) => channel.subscribe(listener),
    });
    const disabled = (name) => f.elements[name].disabled;
    await nextTick();
    assert.equal(disabled('start'), false);
    assert.equal(f.elements.panel.classList.contains('has-shots'), true);

    f.state.selectedShotId = null;
    channel.publish({ type: 'selection-changed' });
    await nextTick();
    assert.equal(disabled('update'), true);

    f.state.scenes[0].shots = [];
    channel.publish({ type: 'shot-deleted' });
    await nextTick();
    assert.equal(disabled('start'), true);
    assert.equal(disabled('next'), true);
    assert.equal(f.elements.panel.classList.contains('has-shots'), false);

    // A run that ends hands the buttons back with the idle rules applied.
    f.state.running = true;
    channel.publish({ type: 'buttons-changed' });
    await nextTick();
    assert.equal(disabled('capture'), true);
    assert.equal(disabled('stop'), false);
    f.state.running = false;
    channel.publish({ type: 'buttons-changed' });
    await nextTick();
    assert.equal(disabled('capture'), false);
    assert.equal(disabled('start'), true);

    f.state.scenes = [];
    f.state.selectedSceneId = null;
    channel.publish({ type: 'scene-deleted' });
    await nextTick();
    assert.equal(disabled('delete'), true);
    assert.equal(disabled('capture'), true);
    assert.equal(disabled('new'), false);

    f.state.scenes = [{ id: 'scene-b', title: 'B', shots: [{ id: 's' }] }];
    f.state.selectedSceneId = 'scene-b';
    f.state.selectedShotId = 's';
    channel.publish({ type: 'project-imported' });
    await nextTick();
    assert.equal(disabled('start'), false);
    assert.equal(f.elements.panel.classList.contains('has-shots'), true);

    owner.destroy();
    await nextTick();
    assert.equal(f.elements.panel.classList.contains('has-shots'), false);
    channel.destroy();
  } finally {
    f.restore();
  }
});

test('Authoring PLAY uses the scene context, not the radio PLAY', async (context) => {
  context.after(() => setLocale('en'));
  setLocale('es');
  const f = fixture();
  try {
    await nextTick();
    assert.equal(f.elements.start.textContent, 'REPRODUCIR');
  } finally {
    f.restore();
  }
});

test('IMPORT clears its chooser only once the import settles, and is inert without an owner', async () => {
  const f = fixture();
  try {
    let finish;
    f.actions.import = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    Object.defineProperty(f.elements.file, 'files', {
      value: [{ name: 'project.json' }],
    });
    Object.defineProperty(f.elements.file, 'value', {
      value: 'project.json',
      writable: true,
    });
    f.elements.file.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.elements.file.value, 'project.json', 'still importing');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.elements.file.value, '');

    let opened = 0;
    f.elements.file.click = () => opened++;
    f.elements.import.click();
    assert.equal(opened, 1);
    f.owner.destroy();
    f.elements.import.click();
    assert.equal(opened, 1, 'no chooser once the owner is gone');
  } finally {
    f.restore();
  }
});
