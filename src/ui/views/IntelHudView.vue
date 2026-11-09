<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useHudStore } from '../stores/hud.js';
import { useCockpitStore } from '../stores/cockpit.js';
import { cockpitEntryFace } from '../cockpitPresentation.js';

// The readouts, visibility, layout variant and colors IntelHUD publishes.
const { hud } = storeToRefs(useHudStore());
// The corners and edges render from mount, before IntelHUD presents them:
// the panel layout controllers register them as obstacles synchronously,
// right after IntelHUD is built.
const EMPTY = Object.freeze({ vessel: {}, sensor: [], recShown: null });
const view = computed(() => hud.value ?? EMPTY);
// The selected vehicle's readout offers the same entry as the Contacts
// button, so first person needs no Contacts panel. The Cockpit controller
// answers its clicks.
const { presence: cockpit } = storeToRefs(useCockpitStore());
// The entry names the subject it would ride (cockpitEntryFace).
const entry = computed(() => cockpitEntryFace(cockpit.value?.entryKind));
</script>

<template>
  <div id="intel-hud" :class="{ active: hud?.active }" :data-variant="hud?.variant" :style="hud?.colors ?? undefined">
    <div class="hud-sonar" aria-hidden="true"></div>
    <div class="hud-corner hud-top-left">
      <div class="hud-bracket">┌</div>
      <div class="hud-content">
        <div class="hud-readout"><div class="hud-classification">{{ view.classification }}</div></div>
        <div class="hud-readout"><div class="hud-system">{{ view.system }}</div></div>
        <div class="hud-readout"><div class="hud-mode" id="hud-mode">{{ view.mode }}</div></div>
        <div class="hud-summary-wrap">
          <div class="hud-readout"><div class="hud-summary-label">{{ view.summaryLabel }}</div></div>
          <div class="hud-readout"><div class="hud-summary" id="hud-summary">{{ view.summary }}</div></div>
        </div>
      </div>
    </div>
    <div class="hud-corner hud-top-right">
      <div class="hud-content" style="text-align: right">
        <div class="hud-readout"><div class="hud-rec"><span id="hud-rec-dot" :style="view.recShown === null ? undefined : { visibility: view.recShown ? 'visible' : 'hidden' }">●</span>{{ view.rec ? ` ${view.rec}  ` : '' }}<span id="hud-timestamp">{{ view.timestamp }}</span></div></div>
        <div class="hud-readout"><div class="hud-orbital">{{ view.orbital }}</div></div>
      </div>
      <div class="hud-bracket">┐</div>
    </div>
    <div class="hud-corner hud-bottom-left">
      <div class="hud-bracket">└</div>
      <div class="hud-content">
        <div class="hud-readout"><div id="hud-mgrs">{{ view.mgrs }}</div></div>
        <div class="hud-readout"><div id="hud-latlon">{{ view.latlon }}</div></div>
      </div>
    </div>
    <div class="hud-corner hud-bottom-right">
      <div class="hud-content" style="text-align: right">
        <div class="hud-readout"><div id="hud-gsd">{{ view.gsd }}</div></div>
        <div class="hud-readout"><div id="hud-alt">{{ view.alt }}</div></div>
        <div class="hud-readout"><div id="hud-ais-vessel" :class="['hud-ais-vessel', { active: view.vessel.active }]">{{ view.vessel.text }}</div></div>
        <button id="cockpit-entry-readout" type="button" :hidden="!cockpit?.entryAvailable">
          <span class="material-symbols-outlined" aria-hidden="true">{{ entry.icon }}</span>
          <span>{{ entry.label }}</span>
        </button>
      </div>
      <div class="hud-bracket">┘</div>
    </div>
    <div class="hud-edge hud-left-edge">
      <div class="hud-readout"><div id="hud-coll">{{ view.coll }}</div></div>
      <div class="hud-readout"><div id="hud-ona">{{ view.ona }}</div></div>
    </div>
    <div class="hud-edge hud-right-edge">
      <div v-for="line in view.sensor" :key="line" class="hud-readout"><div>{{ line }}</div></div>
    </div>
    <div class="hud-bottom-bar">
      <span class="hud-readout"><span id="hud-bottom-line">{{ view.bottom }}</span></span>
    </div>
  </div>
</template>
