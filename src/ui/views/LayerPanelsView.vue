<script setup>
import SceneOptions from './SceneOptions.vue';
import SceneShotList from './SceneShotList.vue';
import StreetLevelPanel from './panels/StreetLevelPanel.vue';
</script>

<template>
  <div id="left-panel-stack">
  <!-- Data Layer Toggle Panel -->
  <div id="data-panel" class="panel-collapsible collapsed active" data-panel-id="data-panel">
    <div class="panel-glow"></div>
    <div class="data-panel-inner">
      <div class="panel-header">
        <span class="panel-title" data-i18n>DATA LAYERS</span>
        <span class="panel-divider"></span>
        <button class="panel-collapse-btn" data-collapse-target="data-panel" title="Collapse panel" data-i18n-title>+</button>
      </div>
      <div id="data-toggles" class="data-toggle-list"></div>
    </div>
  </div>

  <!-- CCTV Coverage Panel -->
  <div id="cctv-panel" class="panel-collapsible collapsed" data-panel-id="cctv-panel">
    <div class="panel-glow"></div>
    <div class="cctv-panel-inner" data-rail-scroller>
      <div class="panel-header">
        <span class="panel-title" data-i18n>CCTV</span>
        <span class="panel-divider"></span>
        <button class="panel-collapse-btn" data-collapse-target="cctv-panel" title="Collapse panel" data-i18n-title>+</button>
      </div>
      <div class="cyber-panel-body" data-rail-scroller>
      <div id="cctv-frame-wrap" class="cctv-frame-wrap">
        <span class="cctv-frame-caption" aria-hidden="true" data-i18n>ACQUIRING FRAME</span>
        <img id="cctv-frame" alt="CCTV feed frame" />
        <canvas id="cctv-video" class="cctv-frame" hidden></canvas>
      </div>
      <div id="cctv-source-badge" class="gev-status-badge" role="status" aria-live="polite" data-i18n>SOURCE · UNKNOWN</div>
      <div id="cctv-meta" data-i18n>Enable CCTV to load camera intersections</div>
      <div class="cctv-controls">
        <button id="cctv-enable-btn" class="scene-btn" data-i18n>CCTV OFF</button>
        <button id="cctv-nearest-btn" type="button" class="gev-action-button scene-btn" data-i18n>NEAREST</button>
      </div>
      <div class="cctv-controls">
        <button id="cctv-prev-btn" type="button" class="gev-action-button scene-btn" data-i18n>PREV</button>
        <select class="gev-field" id="cctv-camera-select" aria-label="CCTV camera" data-i18n-aria-label></select>
        <button id="cctv-next-btn" type="button" class="gev-action-button scene-btn" data-i18n>NEXT</button>
      </div>
      <div class="cctv-controls">
        <button id="cctv-focus-btn" type="button" class="gev-action-button scene-btn" data-i18n>FOCUS</button>
        <button id="cctv-coverage-btn" class="scene-btn" data-i18n>COVERAGE OFF</button>
        <button id="cctv-auto-hop-btn" class="scene-btn" data-i18n>AUTO HOP OFF</button>
      </div>
      <div class="cctv-controls">
        <button id="cctv-projection-btn" class="scene-btn" data-i18n>PROJECTION ON</button>
        <span id="cctv-quality-chip" class="gev-status-badge gev-status-badge--box" data-i18n-runtime>CAL · --</span>
      </div>
      <div class="cctv-calibration-block">
        <div class="cctv-calibration-header">
          <div class="cctv-summary-label" data-i18n>CALIBRATION</div>
          <button id="cctv-adjust-btn" class="scene-btn" title="Drag the camera in the world: rings rotate, arrows move, handles set range/FOV" data-i18n-title data-i18n>ADJUST</button>
        </div>
        <div id="cctv-cal-readout" class="cctv-cal-readout" aria-label="Camera pose — click a value to type" data-i18n-aria-label>
          <button class="cctv-cal-value" data-cal-field="heading" title="Heading (compass °) — click to type" data-i18n-title data-i18n-runtime>HDG --</button>
          <button class="cctv-cal-value" data-cal-field="pitch" title="Pitch (° up/down) — click to type" data-i18n-title data-i18n-runtime>PITCH --</button>
          <button class="cctv-cal-value" data-cal-field="fov" title="Horizontal FOV (°) — click to type" data-i18n-title data-i18n-runtime>FOV --</button>
          <button class="cctv-cal-value" data-cal-field="range" title="Range / monitor-plane distance (m) — click to type" data-i18n-title data-i18n-runtime>RANGE --</button>
          <button class="cctv-cal-value" data-cal-field="height" title="Mount height above ground (m) — click to type" data-i18n-title data-i18n-runtime>HGT --</button>
          <button class="cctv-cal-value" data-cal-field="north" title="North offset from catalog position (m) — click to type" data-i18n-title>ΔN --</button>
          <button class="cctv-cal-value" data-cal-field="east" title="East offset from catalog position (m) — click to type" data-i18n-title>ΔE --</button>
        </div>
        <div class="cctv-controls cctv-calibration-actions">
          <button id="cctv-calib-save-btn" type="button" class="gev-action-button scene-btn" data-i18n>SAVE CAL</button>
          <button id="cctv-calib-reset-btn" type="button" class="gev-action-button scene-btn" data-i18n>RESET CAL</button>
        </div>
      </div>
      <div class="cctv-summary-label" data-i18n>SCENE SUMMARY</div>
      <div id="cctv-summary" data-i18n>Enable CCTV to start camera-linked intelligence summaries.</div>
      </div>
    </div>
  </div>

  <!-- Street Level Panel (moved into #right-context-rail at runtime) -->
  <StreetLevelPanel />

  <!-- Scene Director Panel -->
  <div id="scene-panel" class="panel-collapsible collapsed" data-panel-id="scene-panel">
    <div class="panel-glow"></div>
    <div class="scene-panel-inner">
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
      <div class="scene-progress">
        <div id="scene-progress-fill">0%</div>
      </div>
      <div id="scene-status" role="status" aria-live="polite" data-i18n>Ready</div>
    </div>
  </div>

  </div>
</template>
