// src/scenes/sharingDialogs.test.mjs — scene sharing drives its authoring bar
// and dialogs through the store, drawn by the scene panels view (happy-dom).
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createSceneSharing } from './sharing.js';
import { stringifySceneDocument } from '../director/document.js';
import { useSceneSharingStore } from '../ui/stores/sceneSharing.js';
import LayerPanelsView from '../ui/views/LayerPanelsView.vue';
import { applicationPinia } from '../ui/vueRuntime.js';

HTMLDialogElement.prototype.showModal ??= function () {
  this.open = true;
};

const project = () => ({
  version: 6,
  scenes: [
    {
      id: 'one',
      title: 'Example',
      shots: [
        {
          id: 'shot',
          title: 'Original',
          durationSec: 3,
          holdSec: 2,
          camera: { lat: 1, lon: 2, alt: 300, pitch: -60 },
        },
      ],
    },
  ],
});

function fixture(t, { imported = true } = {}) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  // The owner presents through the application's store.
  const pinia = applicationPinia();
  const app = createApp(LayerPanelsView).use(pinia);
  app.mount(host);
  const imports = [];
  let finishImport = null;
  const director = {
    _project: project(),
    _selectedSceneId: 'one',
    _selectedShotId: 'shot',
    _getSelectedScene() {
      return this._project.scenes[0];
    },
    _updateStatus() {},
    styleManager: {
      getCameraState: () => ({
        lat: 5,
        lon: 6,
        alt: 700,
        heading: 0,
        pitch: -30,
        roll: 0,
      }),
    },
    _bundleAssets: { snapshot: () => new Map() },
    _dataPacks: { sourceIds: () => [] },
    dataManager: { getAll: () => [] },
    importProjectFile(file, options) {
      imports.push(options);
      return new Promise((resolve) => {
        finishImport = () => resolve(imported);
      });
    },
  };
  const sharing = createSceneSharing(director);
  t.after(() => {
    sharing.destroy();
    app.unmount();
  });
  return {
    sharing,
    imports,
    finish: () => finishImport?.(),
    store: useSceneSharingStore(pinia),
  };
}

const $ = (selector) => document.querySelector(selector);
const button = (label) =>
  [...document.querySelectorAll('[data-director-dialog] button')].find(
    (node) => node.textContent === label,
  );
const status = () => $('[data-director-dialog] [role=status]').textContent;
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

test('mounting offers the authoring bar and destroying withdraws it', async (t) => {
  const { sharing, store } = fixture(t);
  sharing.mount();
  await nextTick();
  assert.ok($('[data-director-authoring]'));
  sharing.destroy();
  await nextTick();
  assert.equal($('[data-director-authoring]'), null);
  assert.equal(store.toolbar, null);
});

test('EDIT DETAILS drafts in its fields, says what changed and applies the draft', async (t) => {
  const { sharing, imports, finish } = fixture(t);
  sharing.edit();
  await nextTick();
  assert.equal(
    $('[data-director-dialog]').getAttribute('aria-label'),
    'Edit scene details',
  );
  const [scene, shot] = document.querySelectorAll(
    '[data-director-dialog] textarea',
  );
  assert.deepEqual(JSON.parse(scene.value), {});
  assert.equal(JSON.parse(shot.value).durationSec, 3);
  // Camera helpers sit in the body, Apply in the footer by its hook.
  const capture = button('Capture camera as anchor');
  assert.equal(capture.parentElement.nextElementSibling.role, 'status');
  capture.click();
  await settle();
  assert.equal(status(), 'Anchor added to draft');
  assert.equal(JSON.parse(scene.value).anchors[0].lat, 5);

  shot.value = '{';
  shot.dispatchEvent(new Event('input', { bubbles: true }));
  button('Use ordinary flight').click();
  await nextTick();
  assert.equal(status(), 'Invalid shot JSON');
  shot.value = JSON.stringify({
    camera: { lat: 1, lon: 2, alt: 300, pitch: -60 },
    durationSec: 3,
    holdSec: 4,
  });
  shot.dispatchEvent(new Event('input', { bubbles: true }));

  $('[data-director-apply-details]').click();
  await settle();
  assert.equal(imports.length, 1);
  assert.equal(imports[0].prepared.project.scenes[0].shots[0].holdSec, 4);
  assert.equal(imports[0].prepared.project.scenes[0].anchors[0].id, 'anchor-1');
  finish();
  await settle();
  assert.equal($('[data-director-dialog]'), null);
  assert.equal(sharing.getState().open, false);
});

test('SHARE SCENE offers the JSON download and file and folder choosers', async (t) => {
  const { sharing } = fixture(t);
  sharing.share();
  await nextTick();
  assert.equal(
    $('[data-director-dialog]').getAttribute('aria-label'),
    'Share selected scene',
  );
  assert.ok(button('Download scene JSON'));
  assert.ok(button('Download asset bundle'));
  const [files, folder] = document.querySelectorAll(
    '[data-director-dialog] input[type=file]',
  );
  assert.equal(files.multiple, true);
  assert.equal(files.hasAttribute('webkitdirectory'), false);
  assert.equal(folder.multiple, true);
  assert.equal(folder.hasAttribute('webkitdirectory'), true);
});

test('an import review holds Apply disabled while the import runs and reopens it on refusal', async (t) => {
  const { sharing, imports, finish } = fixture(t, { imported: false });
  const text = stringifySceneDocument(project());
  await sharing.preview({
    name: 'scene.json',
    size: text.length,
    text: async () => text,
  });
  await settle();
  assert.equal(status(), 'Ready to import');
  const apply = $('[data-director-apply-import]');
  assert.equal(apply.textContent, 'Apply import');
  apply.click();
  await settle();
  assert.equal(imports.length, 1);
  assert.equal($('[data-director-apply-import]').disabled, true);
  finish();
  await settle();
  assert.equal($('[data-director-apply-import]').disabled, false);
  assert.equal(
    status(),
    'Import was not applied. The current project may have changed.',
  );
  button('Cancel').click();
  await nextTick();
  assert.equal($('[data-director-dialog]'), null);
});
