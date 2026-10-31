<script setup>
import { storeToRefs } from 'pinia';
import { vClassToggle } from '../rail/classToggle.js';
import { useContextStore } from '../stores/context.js';
import AwarenessPanel from './panels/AwarenessPanel.vue';
import RadioPanel from './panels/RadioPanel.vue';

// ContextControls presents the mode switch and the nearby sites search and
// publishes them; until it does, the panel shows its initial markup.
const { view: ctx } = storeToRefs(useContextStore());
</script>

<template>
  <!-- Global Context is deliberately independent from the left layer accordion. -->
  <aside id="right-context-rail">
    <div id="weather-panel" class="panel-collapsible" data-panel-id="weather-panel" hidden>
      <div class="panel-glow"></div>
      <div class="weather-panel-inner" data-rail-scroller>
        <div class="panel-header">
          <span class="panel-title" data-i18n>WEATHER</span>
          <span id="weather-panel-count" aria-label="Active weather products" data-i18n-aria-label>0</span>
          <span class="panel-divider"></span>
          <button class="panel-collapse-btn" data-collapse-target="weather-panel" type="button" title="Collapse panel" data-i18n-title>▼</button>
        </div>
        <div id="weather-panel-body" data-rail-scroller></div>
      </div>
    </div>
    <div id="recent-imagery-panel" class="panel-collapsible" data-panel-id="recent-imagery-panel" hidden>
      <div class="panel-glow"></div>
      <div class="recent-imagery-panel-inner" data-rail-scroller>
        <div class="panel-header">
          <span class="panel-title" data-i18n>RECENT IMAGERY</span>
          <span id="recent-imagery-panel-count" aria-label="Imagery days in the box" data-i18n-aria-label></span>
          <span class="panel-divider"></span>
          <button class="panel-collapse-btn" data-collapse-target="recent-imagery-panel" type="button" title="Collapse panel" data-i18n-title>▼</button>
        </div>
        <div id="recent-imagery-panel-body" data-rail-scroller></div>
      </div>
    </div>
    <div id="global-context-panel" class="panel-collapsible collapsed" v-class-toggle="{ ...(ctx && { 'context-enabled': ctx.enabled }) }" :data-context-mode="ctx?.mode" data-panel-id="global-context-panel">
      <div class="panel-glow"></div>
      <div class="global-context-panel-inner" data-rail-scroller>
        <div class="panel-header">
          <span class="panel-title" data-i18n>CONTEXT</span>
          <span class="panel-divider"></span>
          <button class="panel-collapse-btn" data-collapse-target="global-context-panel" title="Expand panel" data-i18n-title>▶</button>
        </div>
        <div class="cyber-panel-body" data-rail-scroller>
        <div class="global-context-modes" role="tablist" aria-label="Context mode" data-i18n-aria-label>
          <button id="global-context-flights-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.flightsActive }" type="button" role="tab" tabindex="0" :aria-selected="String(ctx?.flightsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-flights-view" aria-label="CONTACTS" title="Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently." data-i18n-aria-label data-i18n-title>
            <span class="material-symbols-outlined" aria-hidden="true">radar</span>
            <span data-i18n>CONTACTS</span>
          </button>
          <button id="global-context-missions-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.missionsActive }" type="button" role="tab" tabindex="0" :aria-selected="String(ctx?.missionsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-missions-view">
            <span class="material-symbols-outlined" aria-hidden="true">rocket_launch</span>
            <span data-i18n>SPACE MISSIONS</span>
          </button>
        </div>
        <div id="context-mode-standby" class="context-mode-standby" :hidden="ctx?.enabled">
          <strong data-i18n>SELECT CONTEXT</strong>
          <span data-i18n-runtime>CONTACTS — nearest planes · vessels · sites<br>SPACE MISSIONS — launches &amp; orbital assets</span>
        </div>
        <section id="context-flights-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-flights-btn" :hidden="!ctx?.flightsActive">
          <div class="global-context-actions" aria-label="Contact Context actions" data-i18n-aria-label>
            <button id="cockpit-entry" type="button" hidden>
              <span class="material-symbols-outlined" aria-hidden="true">flight</span>
              <span data-i18n>COCKPIT</span>
            </button>
            <button id="installations-search-btn" class="panel-layer-toggle" type="button" :aria-disabled="ctx && String(ctx.installationsBusy)" :aria-busy="ctx && String(ctx.installationsBusy)" data-i18n>SEARCH NEARBY SITES</button>
            <button id="tr3b-toggle" class="tr3b-toggle" type="button" aria-pressed="false" hidden aria-label="Reclassify tracked contact as TR-3B" title="Reclassify as TR-3B" data-i18n-aria-label data-i18n-title>🛸</button>
          </div>
          <AwarenessPanel />
        </section>
        <section id="context-missions-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-missions-btn" :hidden="!ctx?.missionsActive">
          <div id="space-mission-panel-host">
            <div id="space-mission-roster" class="space-mission-roster" aria-label="Available Space Missions" data-i18n-aria-label>
              <div class="space-mission-roster-header">
                <div>
                  <strong data-i18n>AVAILABLE MISSIONS</strong>
                  <span data-i18n>SELECT A MISSION TO INSPECT</span>
                </div>
                <output data-mission-roster-count>—</output>
              </div>
              <div class="space-mission-roster-list" data-mission-roster-list>
                <div class="space-mission-roster-empty" data-i18n>LOADING 30-DAY MISSION INDEX</div>
              </div>
              <p class="space-mission-roster-focus-continuation" tabindex="-1" data-mission-roster-focus-continuation data-i18n>TAB PREVIEWS · ENTER / SPACE SELECTS</p>
            </div>
          </div>
        </section>
        <RadioPanel />
        </div>
      </div>
    </div>
  </aside>

  <div id="scene-runtime"></div>
</template>
