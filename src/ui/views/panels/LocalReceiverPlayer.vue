<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';

// Radio in Context with the local receiver chosen on its Data Layers row: a
// compact player for the USB receiver (RTL-SDR) in place of the station
// list. Connect, seek and the volume reach LocalSdrControls through the
// store, as the full card on the row does; that card keeps the tuning,
// gain and mode.
const radio = useRadioStore();
const { sdr } = storeToRefs(radio);
const { act } = radio;
</script>

<template>
  <section class="radio-stations local-receiver" :aria-label="t('Local receiver')">
    <p class="radio-stations__eyebrow">{{ t('Local receiver') }}</p>
    <div class="radio-stations__now">
      <div class="radio-stations__now-head">
        <UiIcon name="radio" :size="null" />
        <strong>{{ t('LOCAL RTL-SDR') }}</strong>
        <span class="radio-stations__state" :class="{ 'is-on': sdr?.connectionActive }">{{ sdr?.connectionLabel ?? '' }}</span>
      </div>
      <p class="radio-stations__meta local-receiver__status" :class="{ 'is-error': sdr?.statusError }" role="status" aria-live="polite">{{ sdr ? sdr.statusText : t('Connect an RTL-SDR to begin.') }}</p>
      <label class="local-receiver__volume">
        <span>{{ t('SDR VOL') }}</span>
        <UiSlider hold min="0" max="100" :aria-label="t('Local SDR volume')" :disabled="sdr ? sdr.volumeDisabled : true" :model-value="sdr ? sdr.volume : 80" @update:model-value="act('setSdrVolume', $event)" />
        <output class="gev-slider-value">{{ sdr ? sdr.volumeText : '80%' }}</output>
      </label>
      <div class="radio-stations__actions">
        <UiButton class="entity-card__action" :pressed="sdr?.connectPressed ?? false" pressed-class="entity-card__action--on" :disabled="sdr ? sdr.connectDisabled : true" @click="act('toggleSdrConnection')">
          {{ sdr ? sdr.connectLabel : t('CONNECT') }}
        </UiButton>
        <span class="radio-stations__seek" role="group" :aria-label="t('Seek broadcast FM stations')">
          <UiButton class="entity-card__action" :disabled="sdr ? sdr.seekDisabled : true" @click="act('seekSdr', -1)">{{ t('◀ SEEK') }}</UiButton>
          <UiButton class="entity-card__action" :disabled="sdr ? sdr.seekDisabled : true" @click="act('seekSdr', 1)">{{ t('SEEK ▶') }}</UiButton>
        </span>
      </div>
    </div>
  </section>
</template>
