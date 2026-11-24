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
import UiIcon from '../../kit/UiIcon.vue';

// The Cockpit's Display and Radio launchers and their popovers, and the
// desktop look's rail, whose icons stay at the edge and open one panel at a
// time as the main page's rails do. RadioControls presents which popover is
// open and the compact Radio controls; until it does, both are closed and the
// controls show their initial state. The controls call RadioControls through
// the store. The Display popover's slots
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
        <UiButton v-if="open.display" class="cockpit-utility-collapse" :aria-label="t('Collapse panel')" :title="t('Collapse panel')" @click="act('toggleCockpitUtility', 'display', { returnFocus: true })">−</UiButton>
        <UiButton id="cockpit-display-toggle-btn" class="cockpit-utility-glyph" :aria-expanded="String(open.display)" aria-controls="cockpit-display-panel" :aria-label="displayLabel" :title="displayLabel">{{ open.display ? '▶' : '◀' }}</UiButton>
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
        <UiButton v-if="open.radio" class="cockpit-utility-collapse" :aria-label="t('Collapse panel')" :title="t('Collapse panel')" @click="act('toggleCockpitUtility', 'radio', { returnFocus: true })">−</UiButton>
        <UiButton id="cockpit-radio-toggle-btn" @click="act('toggleCockpitRadio')" class="cockpit-utility-glyph" :aria-expanded="String(open.radio)" aria-controls="cockpit-radio-panel" :aria-label="radioLabel" :title="radioLabel">{{ open.radio ? '▶' : '◀' }}</UiButton>
      </div>
      <div id="cockpit-radio-panel" class="cockpit-utility-popover cockpit-radio-compact" role="group" :aria-label="t('Cockpit compact Radio controls')" :hidden="!open.radio">
        <strong id="cockpit-radio-station" class="cockpit-radio-station">{{ cockpit ? cockpit.station : t('READY') }}</strong>
        <UiButton id="cockpit-radio-enable-btn" @click="act('toggleRadio', 'cockpit')" class="panel-layer-toggle" :pressed="Boolean(cockpit?.enable.active)" pressed-class="active" :aria-label="cockpit?.enable.label" :aria-disabled="cockpit ? String(cockpit.enable.busy) : undefined" :aria-busy="cockpit ? String(cockpit.enable.busy) : undefined">{{ cockpit ? cockpit.enable.text : t('ENABLE') }}</UiButton>
        <div class="cockpit-radio-transport">
          <UiButton id="cockpit-radio-prev-btn" @click="act('cycleRadio', -1, { rotate: false })" :aria-label="t('Previous filtered radio station')" :disabled="radio ? radio.transport.stepDisabled : true">◀◀</UiButton>
          <UiButton id="cockpit-radio-play-btn" @click="act('toggleRadioPlayback')" v-class-toggle="{ active: radio?.transport.play.active }" :aria-label="radio ? radio.transport.play.label : t('Play selected radio station')" :title="cockpit?.play.title" :disabled="radio ? radio.transport.play.disabled : true">{{ cockpit ? cockpit.play.glyph : '▶' }}</UiButton>
          <UiButton id="cockpit-radio-next-btn" @click="act('cycleRadio', 1, { rotate: false })" :aria-label="t('Next filtered radio station')" :disabled="radio ? radio.transport.stepDisabled : true">▶▶</UiButton>
        </div>
        <label class="cockpit-radio-volume" for="cockpit-radio-volume">
          <span>{{ t('VOLUME') }}</span>
          <UiSlider id="cockpit-radio-volume" hold @update:model-value="act('setRadioVolume', $event)" min="0" max="100" :aria-label="t('Cockpit Radio volume')" :disabled="cockpit ? cockpit.volume.disabled : true" :model-value="cockpit ? cockpit.volume.value : 80" />
          <output id="cockpit-radio-volume-value" class="gev-slider-value" for="cockpit-radio-volume">{{ cockpit ? `${cockpit.volume.value}%` : '80%' }}</output>
        </label>
      </div>
    </div>
    <div class="cockpit-utility-rail" :class="{ 'is-open': open.display || open.radio }">
      <span class="cockpit-utility-rail__labels" aria-hidden="true">
        <span>{{ t('DISPLAY') }}</span>
        <span>{{ t('RADIO') }}</span>
      </span>
      <span class="cockpit-utility-rail__icons">
        <UiButton class="cockpit-utility-rail__item" data-cockpit-rail-item="display" :class="{ 'is-on': open.display }" :aria-expanded="String(open.display)" aria-controls="cockpit-display-panel" :aria-label="displayLabel" :title="displayLabel" @click="act('toggleCockpitUtility', 'display')"><UiIcon name="tune" :size="null" /></UiButton>
        <UiButton class="cockpit-utility-rail__item" data-cockpit-rail-item="radio" :class="{ 'is-on': open.radio }" :aria-expanded="String(open.radio)" aria-controls="cockpit-radio-panel" :aria-label="radioLabel" :title="radioLabel" @click="act('toggleCockpitUtility', 'radio')"><UiIcon name="radio" :size="null" /></UiButton>
      </span>
    </div>
  </aside>
</template>
