<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import RailPanel from '../rail/RailPanel.vue';
import { vClassToggle } from '../rail/classToggle.js';
import { useCockpitStore } from '../stores/cockpit.js';
import { useBhoteKoshiPanelStore } from '../stores/bhoteKoshiPanel.js';
import { useContextStore } from '../stores/context.js';
import { useSceneStore } from '../stores/scenes.js';
import AwarenessPanel from './panels/AwarenessPanel.vue';
import BhoteKoshiPanel from './panels/BhoteKoshiPanel.vue';
import MissionDetail from './panels/MissionDetail.vue';
import MissionRoster from './panels/MissionRoster.vue';
import RadioPanel from './panels/RadioPanel.vue';
import UiButton from '../kit/UiButton.vue';
import { cockpitEntryFace } from '../cockpitPresentation.js';

// ContextControls presents the mode switch and the nearby sites search and
// publishes them; until it does, the panel shows its initial markup.
const { view: ctx } = storeToRefs(useContextStore());
const { presence: cockpit } = storeToRefs(useCockpitStore());
// The entry names the subject it would ride (cockpitEntryFace).
const entry = computed(() => cockpitEntryFace(cockpit.value?.entryKind));
// While the Bhote Koshi event is on, its panel is the rail's only content.
const { panel: bhotePanel } = storeToRefs(useBhoteKoshiPanelStore());
// The Scene runtime chip SceneControls presents while a scene plays.
const { panel: scenePanel } = storeToRefs(useSceneStore());
const sceneRuntime = computed(() => scenePanel.value?.runtime ?? '');
</script>

<template>
  <!-- Global Context is deliberately independent from the left layer accordion. -->
  <aside id="right-context-rail" class="ui-scroll" v-class-toggle="{ 'bhote-event-active': !!bhotePanel }">
    <RailPanel id="weather-panel" hidden :title="t('WEATHER')" sideways rail-scroller>
      <template #badge><span id="weather-panel-count" :aria-label="t('Active weather products')">0</span></template>
      <div id="weather-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="news-panel" hidden :title="t('NEWS')" sideways rail-scroller>
      <template #badge><span id="news-panel-count" :aria-label="t('News items in the feed')">0</span></template>
      <div id="news-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="recent-imagery-panel" hidden :title="t('RECENT IMAGERY')" sideways rail-scroller>
      <template #badge><span id="recent-imagery-panel-count" :aria-label="t('Imagery days in the box')"></span></template>
      <div id="recent-imagery-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="global-context-panel" start-collapsed v-class-toggle="{ ...(ctx && { 'context-enabled': ctx.enabled }) }" :data-context-mode="ctx?.mode" :title="t('CONTEXT')" sideways scroll rail-scroller>
        <div class="cyber-panel-body ui-scroll" data-rail-scroller>
        <div class="global-context-modes" role="tablist" :aria-label="t('Context mode')">
          <button id="global-context-flights-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.flightsActive }" type="button" role="tab" tabindex="0" :aria-selected="String(ctx?.flightsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-flights-view" :aria-label="t('CONTACTS')" :title="t('Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently.')">
            <span class="material-symbols-outlined" aria-hidden="true">radar</span>
            <span>{{ t('CONTACTS') }}</span>
          </button>
          <button id="global-context-missions-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.missionsActive }" type="button" role="tab" tabindex="0" :aria-selected="String(ctx?.missionsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-missions-view">
            <span class="material-symbols-outlined" aria-hidden="true">rocket_launch</span>
            <span>{{ t('SPACE MISSIONS') }}</span>
          </button>
        </div>
        <div id="context-mode-standby" class="context-mode-standby" :hidden="ctx?.enabled">
          <strong>{{ t('SELECT CONTEXT') }}</strong>
          <span>{{ t('CONTACTS — nearest planes · vessels · sites') }}<br>{{ t('SPACE MISSIONS — launches & orbital assets') }}</span>
        </div>
        <section id="context-flights-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-flights-btn" :hidden="!ctx?.flightsActive">
          <div class="global-context-actions" :aria-label="t('Contact Context actions')">
            <button id="cockpit-entry" type="button" :hidden="!cockpit?.entryAvailable">
              <span class="material-symbols-outlined" aria-hidden="true">{{ entry.icon }}</span>
              <span>{{ entry.label }}</span>
            </button>
            <button id="installations-search-btn" class="panel-layer-toggle" type="button" :aria-disabled="ctx && String(ctx.installationsBusy)" :aria-busy="ctx && String(ctx.installationsBusy)">{{ t('SEARCH NEARBY SITES') }}</button>
            <UiButton id="tr3b-toggle" class="tr3b-toggle" :pressed="!!cockpit?.tr3b?.converted" :hidden="!cockpit?.tr3b" :aria-label="t('Reclassify tracked contact as TR-3B')" :title="cockpit?.tr3b?.converted ? t('Restore real aircraft') : t('Reclassify as TR-3B')">🛸</UiButton>
          </div>
          <AwarenessPanel />
        </section>
        <section id="context-missions-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-missions-btn" :hidden="!ctx?.missionsActive">
          <div id="space-mission-panel-host">
            <MissionRoster />
            <MissionDetail />
          </div>
        </section>
        <RadioPanel />
        </div>
    </RailPanel>
    <BhoteKoshiPanel />
  </aside>

  <div id="scene-runtime" :class="{ active: !!sceneRuntime }">{{ sceneRuntime }}</div>
</template>
