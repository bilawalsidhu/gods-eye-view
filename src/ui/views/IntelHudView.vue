<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useHudStore } from '../stores/hud.js';
import { useCockpitStore } from '../stores/cockpit.js';
import { cockpitEntryFace } from '../cockpitPresentation.js';
import UiButton from '../kit/UiButton.vue';
import UiIcon from '../kit/UiIcon.vue';
import { vRootClass } from '../rail/rootClass.js';
import { vTextData } from '../rail/textData.js';

// The readouts, visibility, layout variant and colors IntelHUD publishes.
const hudStore = useHudStore();
const { hud } = storeToRefs(hudStore);
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
const entry = computed(() =>
  cockpitEntryFace(cockpit.value?.entryKind, cockpit.value?.entryFace),
);
// Whether the HUD is on screen: a stylesheet can give #intel-hud or a parent
// `display: none` (the Cockpit does). IntelHUD does no readout work while it
// is not, and shows current readouts as soon as it is again. A resize
// observer reports the box appearing and going; it runs after layout, so
// asking for the box costs no extra layout.
const root = ref(null);
let observer = null;
onMounted(() => {
  const el = root.value;
  const Observer = el?.ownerDocument?.defaultView?.ResizeObserver;
  // Without one there is no telling: the HUD works as if displayed.
  if (!Observer) {
    hudStore.setDisplayed(true);
    return;
  }
  observer = new Observer(() =>
    hudStore.setDisplayed(el.getClientRects().length > 0),
  );
  observer.observe(el);
});
// A view that goes leaves the HUD at rest until a mounted view reports it
// displayed.
onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  hudStore.setDisplayed(false);
});
</script>

<template>
  <div id="intel-hud" ref="root" :class="{ active: hud?.active }" v-root-class="{ 'hud-minimal-active': Boolean(hud?.active) && hud?.variant === 'minimal' }" :data-variant="hud?.variant" :style="hud?.colors ?? undefined">
    <div class="hud-sonar" aria-hidden="true"></div>
    <div class="hud-corner hud-top-left">
      <div class="hud-bracket">┌</div>
      <div class="hud-content">
        <div class="hud-readout"><div class="hud-classification">{{ view.classification }}</div></div>
        <div class="hud-readout"><div class="hud-system">{{ view.system }}</div></div>
        <div class="hud-readout"><div class="hud-mode" id="hud-mode" v-text-data="view.mode"></div></div>
        <div class="hud-summary-wrap">
          <div class="hud-readout"><div class="hud-summary-label">{{ view.summaryLabel }}</div></div>
          <div class="hud-readout"><div class="hud-summary" id="hud-summary" v-text-data="view.summary"></div></div>
        </div>
      </div>
    </div>
    <div class="hud-corner hud-top-right">
      <div class="hud-content" style="text-align: right">
        <div class="hud-readout"><div class="hud-rec"><span id="hud-rec-dot" :style="view.recShown === null ? undefined : { visibility: view.recShown ? 'visible' : 'hidden' }">●</span>{{ view.rec ? ` ${view.rec}  ` : '' }}<span id="hud-timestamp" v-text-data="view.timestamp"></span></div></div>
        <div class="hud-readout"><div class="hud-orbital">{{ view.orbital }}</div></div>
      </div>
      <div class="hud-bracket">┐</div>
    </div>
    <div class="hud-corner hud-bottom-left">
      <div class="hud-bracket">└</div>
      <div class="hud-content">
        <div class="hud-readout"><div id="hud-mgrs" v-text-data="view.mgrs"></div></div>
        <div class="hud-readout"><div id="hud-latlon" v-text-data="view.latlon"></div></div>
      </div>
    </div>
    <div class="hud-corner hud-bottom-right">
      <div class="hud-content" style="text-align: right">
        <div class="hud-readout"><div id="hud-gsd" v-text-data="view.gsd"></div></div>
        <div class="hud-readout"><div id="hud-alt" v-text-data="view.alt"></div></div>
        <div class="hud-readout"><div id="hud-ais-vessel" :class="['hud-ais-vessel', { active: view.vessel.active }]" v-text-data="view.vessel.text"></div></div>
        <UiButton id="cockpit-entry-readout" :hidden="!cockpit?.entryAvailable">
          <UiIcon :name="entry.icon" :size="null" />
          <span>{{ entry.label }}</span>
        </UiButton>
      </div>
      <div class="hud-bracket">┘</div>
    </div>
    <div class="hud-edge hud-left-edge">
      <div class="hud-readout"><div id="hud-coll" v-text-data="view.coll"></div></div>
      <div class="hud-readout"><div id="hud-ona" v-text-data="view.ona"></div></div>
    </div>
    <div class="hud-edge hud-right-edge">
      <div v-for="line in view.sensor" :key="line" class="hud-readout"><div>{{ line }}</div></div>
    </div>
    <div class="hud-bottom-bar">
      <span class="hud-readout"><span id="hud-bottom-line" v-text-data="view.bottom"></span></span>
    </div>
  </div>
</template>
