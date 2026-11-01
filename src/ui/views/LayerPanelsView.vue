<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { useSceneSharingStore } from '../stores/sceneSharing.js';
import SceneDialog from './panels/SceneDialog.vue';
import SceneOptions from './SceneOptions.vue';
import SceneShotList from './SceneShotList.vue';
import CctvPanel from './panels/CctvPanel.vue';
import StreetLevelPanel from './panels/StreetLevelPanel.vue';

// Scene sharing (src/scenes/sharing.js) offers its authoring bar and presents
// its dialog through this store; without this view, neither is drawn.
const { toolbar, dialog } = storeToRefs(useSceneSharingStore());
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
  <div id="scene-panel" class="panel-collapsible collapsed" data-panel-id="scene-panel">
    <div class="panel-glow"></div>
    <div class="scene-panel-inner ui-scroll">
      <div class="panel-header">
        <span class="panel-title" title="Create and edit scenes" data-i18n data-i18n-title>AUTHORING</span>
        <span class="panel-divider"></span>
        <button class="panel-collapse-btn" data-collapse-target="scene-panel" title="Collapse panel" data-i18n-title>+</button>
      </div>
      <p class="scene-step-heading" data-i18n>SCENE</p>
      <div class="scene-controls">
        <select class="gev-field" id="scene-select" aria-label="Scene" data-i18n-aria-label><SceneOptions /></select>
        <button id="scene-new-btn" type="button" class="gev-action-button scene-btn" title="Start a new, empty scene" data-i18n data-i18n-title>NEW SCENE</button>
        <button id="scene-delete-btn" type="button" class="gev-action-button gev-action-button--danger scene-btn scene-btn-danger" title="Delete this scene and all of its shots" data-i18n data-i18n-title>DELETE</button>
      </div>
      <p class="scene-step-heading" data-i18n>SHOTS</p>
      <div class="scene-controls">
        <button id="scene-capture-btn" type="button" class="gev-action-button scene-btn scene-btn-primary" title="Add the current view, style and layers as the next shot" data-i18n data-i18n-title>+ CAPTURE SHOT</button>
        <button id="scene-update-shot-btn" type="button" class="gev-action-button scene-btn" title="Replace the selected shot with the current view" data-i18n data-i18n-title>UPDATE SHOT</button>
      </div>
      <SceneShotList />
      <p class="scene-shot-hint" data-i18n>Click a shot to select it, double-click to rename.</p>
      <p class="scene-step-heading" data-i18n>PREVIEW</p>
      <div class="scene-controls">
        <button id="scene-start-btn" type="button" class="gev-action-button scene-btn scene-btn-primary" title="Play from this scene through the rest of the project" data-i18n-title data-i18n-runtime>PLAY</button>
        <button id="scene-stop-btn" type="button" class="gev-action-button gev-action-button--danger scene-btn scene-btn-danger" title="Stop playback (Esc)" data-i18n data-i18n-title>STOP</button>
        <button id="scene-next-btn" type="button" class="gev-action-button scene-btn" title="Play the shot after the selected one, moving on to the next scene when needed" data-i18n data-i18n-title>NEXT</button>
      </div>
      <p class="scene-step-heading" data-i18n>SAVE &amp; SHARE</p>
      <div class="scene-controls scene-file-controls">
        <button id="scene-export-btn" type="button" class="gev-action-button scene-btn" title="Download every scene as a JSON file you can import later" data-i18n data-i18n-title>EXPORT</button>
        <button id="scene-import-btn" type="button" class="gev-action-button scene-btn" title="Load scenes from an exported JSON file" data-i18n data-i18n-title>IMPORT</button>
        <button id="scene-download-btn" type="button" class="gev-action-button scene-btn" title="Download the timing log of the last play" data-i18n data-i18n-title>RUN LOG</button>
        <input type="file" id="scene-import-file" accept="application/json,.json" hidden />
      </div>
      <div v-if="toolbar" data-director-authoring class="scene-controls">
        <button type="button" class="gev-action-button scene-btn" :title="t('Edit anchors, data packs and shot details')" @click="toolbar.edit()">{{ t('EDIT DETAILS') }}</button>
        <button type="button" class="gev-action-button scene-btn" :title="t('Download this scene as JSON or an asset bundle')" @click="toolbar.share()">{{ t('SHARE SCENE') }}</button>
      </div>
      <div class="scene-progress">
        <div id="scene-progress-fill">0%</div>
      </div>
      <div id="scene-status" role="status" aria-live="polite" data-i18n>Ready</div>
    </div>
  </div>

  </div>
  <Teleport to="body">
    <SceneDialog v-if="dialog" :key="dialog.id" :view="dialog" />
  </Teleport>
</template>
