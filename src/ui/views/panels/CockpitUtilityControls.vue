<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';
import { useCockpitStore } from '../../stores/cockpit.js';
import { useDisplayStore } from '../../stores/display.js';
import UiButton from '../../kit/UiButton.vue';
import UiPanelEdge from '../../kit/UiPanelEdge.vue';

// The open panel's header carries the same edge switch and collapse button as
// the main panels; collapsing goes through each launcher's own toggle.
function collapse(which) {
  if (which === 'radio') act('toggleCockpitRadio');
  else document.getElementById('cockpit-display-toggle-btn')?.click();
}
// The rail opens one panel at a time, as the main page's rails do.
function railToggle(which) {
  const other = which === 'radio' ? 'display' : 'radio';
  if (open.value[other]) collapse(other);
  collapse(which);
}

// The Cockpit's Display and Radio launchers and their popovers. RadioControls
// presents which popover is open and the compact Radio controls; until it
// does, both are closed and the controls show their initial state. The
// controls call RadioControls through the store. The Display popover's slots
// are static: the Display panel teleports its real controls into them while
// the Cockpit display portal publishes them.
const store = useRadioStore();
const { act } = store;
const { view: radio, utility } = storeToRefs(store);
const open = computed(() => utility.value ?? { display: false, radio: false });
const cockpit = computed(() => radio.value?.cockpit ?? null);
// The Cockpit's layout pass measures which controls fit; until it runs, the
// controls carry no aria-hidden.
const { utilityLayout: layout } = storeToRefs(useCockpitStore());
// The Display panel's groups sit in the popover's slots while the Cockpit
// display portal publishes them.
const { cockpitPortal } = storeToRefs(useDisplayStore());
const ariaHidden = (expanded) =>
  layout.value
    ? String(
        layout.value.hideCollapsed &&
          !expanded &&
          (open.value.display || open.value.radio),
      )
    : undefined;
const displayLabel = computed(() =>
  open.value.display
    ? t('Collapse Cockpit display options')
    : t('Expand Cockpit display options'),
);
const radioLabel = computed(() =>
  open.value.radio
    ? t('Collapse Cockpit Radio controls')
    : t('Expand Cockpit Radio controls'),
);
</script>

<template>
  <aside id="cockpit-utility-controls" class="cockpit-utility-controls" v-class-toggle="{ 'layout-primary-only': !!layout?.primaryOnly }" :aria-label="t('Cockpit display and Radio controls')">
    <div class="cockpit-utility-control ui-scroll" v-class-toggle="{ 'is-expanded': open.display }" :aria-hidden="ariaHidden(open.display)">
      <div class="cockpit-utility-launcher" data-cockpit-launcher="display">
        <span>{{ t('DISPLAY') }}</span>
        <span class="cockpit-utility-divider" aria-hidden="true"></span>
        <UiPanelEdge v-if="open.display" />
        <button v-if="open.display" type="button" class="cockpit-utility-collapse" :aria-label="t('Collapse panel')" :title="t('Collapse panel')" @click="collapse('display')">−</button>
        <button id="cockpit-display-toggle-btn" class="cockpit-utility-glyph" type="button" :aria-expanded="String(open.display)" aria-controls="cockpit-display-panel" :aria-label="displayLabel" :title="displayLabel">{{ open.display ? '▶' : '◀' }}</button>
      </div>
      <div id="cockpit-display-panel" class="cockpit-utility-popover ui-scroll" v-class-toggle="{ 'uses-shared-display-controls': !!cockpitPortal }" role="group" :aria-label="t('Cockpit display options')" :hidden="!open.display">
        <div class="cockpit-display-slot" data-cockpit-display-slot="hud"></div>
        <div class="cockpit-display-slot" data-cockpit-display-slot="detection"></div>
        <div class="cockpit-display-slot" data-cockpit-display-slot="parameters"></div>
        <div class="cockpit-display-slot" data-cockpit-display-slot="models3d"></div>
      </div>
    </div>
    <div class="cockpit-utility-control ui-scroll" v-class-toggle="{ 'is-expanded': open.radio }" :aria-hidden="ariaHidden(open.radio)">
      <div class="cockpit-utility-launcher" data-cockpit-launcher="radio">
        <span>{{ t('RADIO') }}</span>
        <span class="cockpit-utility-divider" aria-hidden="true"></span>
        <UiPanelEdge v-if="open.radio" />
        <button v-if="open.radio" type="button" class="cockpit-utility-collapse" :aria-label="t('Collapse panel')" :title="t('Collapse panel')" @click="collapse('radio')">−</button>
        <button id="cockpit-radio-toggle-btn" @click="act('toggleCockpitRadio')" class="cockpit-utility-glyph" type="button" :aria-expanded="String(open.radio)" aria-controls="cockpit-radio-panel" :aria-label="radioLabel" :title="radioLabel">{{ open.radio ? '▶' : '◀' }}</button>
      </div>
      <div id="cockpit-radio-panel" class="cockpit-utility-popover cockpit-radio-compact" role="group" :aria-label="t('Cockpit compact Radio controls')" :hidden="!open.radio">
        <strong id="cockpit-radio-station" class="cockpit-radio-station">{{ cockpit ? cockpit.station : t('READY') }}</strong>
        <UiButton id="cockpit-radio-enable-btn" @click="act('toggleRadio', 'cockpit')" class="panel-layer-toggle" :pressed="cockpit?.enable.active ?? false" pressed-class="active" :aria-label="cockpit?.enable.label" :aria-disabled="cockpit ? String(cockpit.enable.busy) : undefined" :aria-busy="cockpit ? String(cockpit.enable.busy) : undefined">{{ cockpit ? cockpit.enable.text : t('ENABLE') }}</UiButton>
        <div class="cockpit-radio-transport">
          <button id="cockpit-radio-prev-btn" @click="act('cycleRadio', -1, { rotate: false })" type="button" :aria-label="t('Previous filtered radio station')" :disabled="radio ? radio.transport.stepDisabled : true">◀◀</button>
          <button id="cockpit-radio-play-btn" @click="act('toggleRadioPlayback')" type="button" v-class-toggle="{ active: radio?.transport.play.active }" :aria-label="radio ? radio.transport.play.label : t('Play selected radio station')" :title="cockpit?.play.title" :disabled="radio ? radio.transport.play.disabled : true">{{ cockpit ? cockpit.play.glyph : '▶' }}</button>
          <button id="cockpit-radio-next-btn" @click="act('cycleRadio', 1, { rotate: false })" type="button" :aria-label="t('Next filtered radio station')" :disabled="radio ? radio.transport.stepDisabled : true">▶▶</button>
        </div>
        <label class="cockpit-radio-volume" for="cockpit-radio-volume">
          <span>{{ t('VOLUME') }}</span>
          <UiSlider id="cockpit-radio-volume" hold @update:model-value="act('setRadioVolume', $event)" min="0" max="100" :aria-label="t('Cockpit Radio volume')" :disabled="cockpit ? cockpit.volume.disabled : true" :model-value="cockpit ? cockpit.volume.value : 80" />
          <output id="cockpit-radio-volume-value" class="gev-slider-value" for="cockpit-radio-volume">{{ cockpit ? `${cockpit.volume.value}%` : '80%' }}</output>
        </label>
      </div>
    </div>
    <nav class="cockpit-utility-rail" :class="{ 'is-open': open.display || open.radio }" :aria-label="t('Cockpit display and Radio controls')">
      <span class="cockpit-utility-rail__labels" aria-hidden="true">
        <span>{{ t('DISPLAY') }}</span>
        <span>{{ t('RADIO') }}</span>
      </span>
      <span class="cockpit-utility-rail__icons">
        <button type="button" class="cockpit-utility-rail__item" :class="{ 'is-on': open.display }" :aria-pressed="String(open.display)" :aria-label="displayLabel" :title="displayLabel" @click="railToggle('display')"><span class="material-symbols-outlined" aria-hidden="true">tune</span></button>
        <button type="button" class="cockpit-utility-rail__item" :class="{ 'is-on': open.radio }" :aria-pressed="String(open.radio)" :aria-label="radioLabel" :title="radioLabel" @click="railToggle('radio')"><span class="material-symbols-outlined" aria-hidden="true">radio</span></button>
      </span>
    </nav>
  </aside>
</template>
