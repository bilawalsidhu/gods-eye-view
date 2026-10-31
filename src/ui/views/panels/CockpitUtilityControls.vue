<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vFieldValue } from '../../rail/fieldValue.js';
import { useRadioStore } from '../../stores/radio.js';

// The Cockpit's Display and Radio launchers and their popovers. RadioControls
// presents which popover is open and the compact Radio controls; until it
// does, both are closed and the controls show their initial state. The
// controls keep its listeners. The Display popover's slots are static: the
// Cockpit display portal moves the real Display controls into them.
const { view: radio, utility } = storeToRefs(useRadioStore());
const open = computed(() => utility.value ?? { display: false, radio: false });
const cockpit = computed(() => radio.value?.cockpit ?? null);
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
  <aside id="cockpit-utility-controls" class="cockpit-utility-controls" aria-label="Cockpit display and Radio controls" data-i18n-aria-label>
    <div class="cockpit-utility-control" v-class-toggle="{ 'is-expanded': open.display }">
      <div class="cockpit-utility-launcher" data-cockpit-launcher="display">
        <span data-i18n>DISPLAY</span>
        <span class="cockpit-utility-divider" aria-hidden="true"></span>
        <button id="cockpit-display-toggle-btn" class="cockpit-utility-glyph" type="button" :aria-expanded="String(open.display)" aria-controls="cockpit-display-panel" :aria-label="displayLabel" :title="displayLabel">{{ open.display ? '▶' : '◀' }}</button>
      </div>
      <div id="cockpit-display-panel" class="cockpit-utility-popover" role="group" aria-label="Cockpit display options" :hidden="!open.display" data-i18n-aria-label>
        <div class="cockpit-display-slot" data-cockpit-display-slot="hud"></div>
        <div class="cockpit-display-slot" data-cockpit-display-slot="detection"></div>
        <div class="cockpit-display-slot" data-cockpit-display-slot="parameters"></div>
        <div class="cockpit-display-slot" data-cockpit-display-slot="models3d"></div>
      </div>
    </div>
    <div class="cockpit-utility-control" v-class-toggle="{ 'is-expanded': open.radio }">
      <div class="cockpit-utility-launcher" data-cockpit-launcher="radio">
        <span data-i18n>RADIO</span>
        <span class="cockpit-utility-divider" aria-hidden="true"></span>
        <button id="cockpit-radio-toggle-btn" class="cockpit-utility-glyph" type="button" :aria-expanded="String(open.radio)" aria-controls="cockpit-radio-panel" :aria-label="radioLabel" :title="radioLabel">{{ open.radio ? '▶' : '◀' }}</button>
      </div>
      <div id="cockpit-radio-panel" class="cockpit-utility-popover cockpit-radio-compact" role="group" aria-label="Cockpit compact Radio controls" :hidden="!open.radio" data-i18n-aria-label>
        <strong id="cockpit-radio-station" class="cockpit-radio-station">{{ cockpit ? cockpit.station : t('READY') }}</strong>
        <button id="cockpit-radio-enable-btn" class="panel-layer-toggle" v-class-toggle="{ active: cockpit?.enable.active }" type="button" :aria-pressed="String(cockpit?.enable.active ?? false)" :aria-label="cockpit?.enable.label" :aria-disabled="cockpit ? String(cockpit.enable.busy) : undefined" :aria-busy="cockpit ? String(cockpit.enable.busy) : undefined">{{ cockpit ? cockpit.enable.text : t('ENABLE') }}</button>
        <div class="cockpit-radio-transport">
          <button id="cockpit-radio-prev-btn" type="button" aria-label="Previous filtered radio station" :disabled="radio ? radio.transport.stepDisabled : true" data-i18n-aria-label>◀◀</button>
          <button id="cockpit-radio-play-btn" type="button" v-class-toggle="{ active: radio?.transport.play.active }" :aria-label="radio ? radio.transport.play.label : t('Play selected radio station')" :title="cockpit?.play.title" :disabled="radio ? radio.transport.play.disabled : true">{{ cockpit ? cockpit.play.glyph : '▶' }}</button>
          <button id="cockpit-radio-next-btn" type="button" aria-label="Next filtered radio station" :disabled="radio ? radio.transport.stepDisabled : true" data-i18n-aria-label>▶▶</button>
        </div>
        <label class="cockpit-radio-volume" for="cockpit-radio-volume">
          <span data-i18n>VOLUME</span>
          <input id="cockpit-radio-volume" class="gev-quantitative-slider" type="range" min="0" max="100" value="80" aria-label="Cockpit Radio volume" :disabled="cockpit ? cockpit.volume.disabled : true" v-field-value="cockpit ? cockpit.volume.value : 80" data-i18n-aria-label />
          <output id="cockpit-radio-volume-value" class="gev-slider-value" for="cockpit-radio-volume">{{ cockpit ? `${cockpit.volume.value}%` : '80%' }}</output>
        </label>
      </div>
    </div>
  </aside>
</template>
