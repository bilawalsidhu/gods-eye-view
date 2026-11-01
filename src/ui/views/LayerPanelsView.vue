<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { useSceneSharingStore } from '../stores/sceneSharing.js';
import { useSceneStore } from '../stores/scenes.js';
import { vClassToggle } from '../rail/classToggle.js';
import SceneDialog from './panels/SceneDialog.vue';
import SceneOptions from './SceneOptions.vue';
import SceneShotList from './SceneShotList.vue';
import CctvPanel from './panels/CctvPanel.vue';
import StreetLevelPanel from './panels/StreetLevelPanel.vue';

// Scene sharing (src/scenes/sharing.js) offers its authoring bar and presents
// its dialog through this store; without this view, neither is drawn.
const { toolbar, dialog } = storeToRefs(useSceneSharingStore());
// SceneControls presents the Scene panel's buttons, status and progress and
// answers the buttons through the store.
const scenes = useSceneStore();
const { panel: scene } = storeToRefs(scenes);
const off = (name) => scene.value?.disabled[name] ?? false;
// The hidden file input is the IMPORT button's chooser, open only while an
// owner presents the panel. It is cleared once the import settles, so the same
// file can be chosen again, unless the owner went away meanwhile.
function chooseImport(input) {
  if (scenes.attached) input.click();
}
async function importChosen(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file || !scenes.attached) return;
  await scenes.act('importFile', file);
  if (scenes.attached) input.value = '';
}
</script>

<template>
  <div id="left-panel-stack" class="ui-scroll">
  <!-- Data Layer Toggle Panel -->
  <div id="data-panel" class="panel-collapsible collapsed active" data-panel-id="data-panel">
    <div class="panel-glow"></div>
    <div class="data-panel-inner">
      <div class="panel-header">
        <span class="panel-title" data-i18n>DATA LAYERS</span>
        <span class="panel-divider"></span>
        <button class="panel-collapse-btn" data-collapse-target="data-panel" title="Collapse panel" data-i18n-title>+</button>
      </div>
      <div id="data-toggles" class="data-toggle-list ui-scroll"></div>
    </div>
  </div>

  <!-- CCTV Coverage Panel -->
  <CctvPanel />

  <!-- Street Level Panel (moved into #right-context-rail at runtime) -->
  <StreetLevelPanel />

  <!-- Scene Director Panel -->
  <div id="scene-panel" v-class-toggle="{ running: scene?.running, 'has-shots': scene?.hasShots }" class="panel-collapsible collapsed" data-panel-id="scene-panel">
    <div class="panel-glow"></div>
    <div class="scene-panel-inner ui-scroll">
      <div class="panel-header">
        <span class="panel-title" title="Create and edit scenes" data-i18n data-i18n-title>AUTHORING</span>
        <span class="panel-divider"></span>
        <button class="panel-collapse-btn" data-collapse-target="scene-panel" title="Collapse panel" data-i18n-title>+</button>
      </div>
      <p class="scene-step-heading" data-i18n>SCENE</p>
      <div class="scene-controls">
        <select class="gev-field" id="scene-select" aria-label="Scene" data-i18n-aria-label :disabled="off('select')" @change="scenes.act('selectScene', $event.currentTarget.value)"><SceneOptions /></select>
        <button id="scene-new-btn" type="button" :disabled="off('new')" @click="scenes.act('create')" class="gev-action-button scene-btn" title="Start a new, empty scene" data-i18n data-i18n-title>NEW SCENE</button>
        <button id="scene-delete-btn" type="button" :disabled="off('delete')" @click="scenes.act('deleteScene')" class="gev-action-button gev-action-button--danger scene-btn scene-btn-danger" title="Delete this scene and all of its shots" data-i18n data-i18n-title>DELETE</button>
      </div>
      <p class="scene-step-heading" data-i18n>SHOTS</p>
      <div class="scene-controls">
        <button id="scene-capture-btn" type="button" :disabled="off('capture')" @click="scenes.act('capture')" class="gev-action-button scene-btn scene-btn-primary" title="Add the current view, style and layers as the next shot" data-i18n data-i18n-title>+ CAPTURE SHOT</button>
        <button id="scene-update-shot-btn" type="button" :disabled="off('update')" @click="scenes.act('update')" class="gev-action-button scene-btn" title="Replace the selected shot with the current view" data-i18n data-i18n-title>UPDATE SHOT</button>
      </div>
      <SceneShotList />
      <p class="scene-shot-hint" data-i18n>Click a shot to select it, double-click to rename.</p>
      <p class="scene-step-heading" data-i18n>PREVIEW</p>
      <div class="scene-controls">
        <button id="scene-start-btn" type="button" class="gev-action-button scene-btn scene-btn-primary" title="Play from this scene through the rest of the project" data-i18n-title :disabled="off('start')" @click="scenes.act('start')">{{ scene?.playLabel ?? t('PLAY', { context: 'scene' }) }}</button>
        <button id="scene-stop-btn" type="button" :disabled="off('stop')" @click="scenes.act('stop')" class="gev-action-button gev-action-button--danger scene-btn scene-btn-danger" title="Stop playback (Esc)" data-i18n data-i18n-title>STOP</button>
        <button id="scene-next-btn" type="button" :disabled="off('next')" @click="scenes.act('next')" class="gev-action-button scene-btn" title="Play the shot after the selected one, moving on to the next scene when needed" data-i18n data-i18n-title>NEXT</button>
      </div>
      <p class="scene-step-heading" data-i18n>SAVE &amp; SHARE</p>
      <div class="scene-controls scene-file-controls">
        <button id="scene-export-btn" type="button" :disabled="off('export')" @click="scenes.act('export')" class="gev-action-button scene-btn" title="Download every scene as a JSON file you can import later" data-i18n data-i18n-title>EXPORT</button>
        <button id="scene-import-btn" type="button" :disabled="off('import')" @click="chooseImport($refs.sceneFile)" class="gev-action-button scene-btn" title="Load scenes from an exported JSON file" data-i18n data-i18n-title>IMPORT</button>
        <button id="scene-download-btn" type="button" :disabled="off('download')" @click="scenes.act('download')" class="gev-action-button scene-btn" title="Download the timing log of the last play" data-i18n data-i18n-title>RUN LOG</button>
        <input ref="sceneFile" type="file" id="scene-import-file" accept="application/json,.json" hidden @change="importChosen" />
      </div>
      <div v-if="toolbar" data-director-authoring class="scene-controls">
        <button type="button" class="gev-action-button scene-btn" :title="t('Edit anchors, data packs and shot details')" @click="toolbar.edit()">{{ t('EDIT DETAILS') }}</button>
        <button type="button" class="gev-action-button scene-btn" :title="t('Download this scene as JSON or an asset bundle')" @click="toolbar.share()">{{ t('SHARE SCENE') }}</button>
      </div>
      <div class="scene-progress">
        <div id="scene-progress-fill" :style="scene ? { width: `${scene.progress}%` } : undefined">{{ scene?.progress ?? 0 }}%</div>
      </div>
      <div id="scene-status" role="status" aria-live="polite">{{ scene?.status ?? t('Ready') }}</div>
    </div>
  </div>

  </div>
  <Teleport to="body">
    <SceneDialog v-if="dialog" :key="dialog.id" :view="dialog" />
  </Teleport>
</template>
