<script setup>
import { storeToRefs } from 'pinia';
import { VOICE_VISUALIZER_BARS } from '../../../voice/control.js';
import { useVoiceStore } from '../../stores/voice.js';

// The dock waveform. Its bars change every animation frame while voice is
// live, so they render here alone, not with the rest of the control.
const { bars } = storeToRefs(useVoiceStore());
const barStyle = (index) => ({
  '--bar': index,
  ...(bars.value?.[index] && {
    '--audio-level': bars.value[index].level,
    '--audio-opacity': bars.value[index].opacity,
  }),
});
</script>

<template>
  <div class="gev-voice-visualizer" aria-hidden="true">
        <span v-for="index in VOICE_VISUALIZER_BARS" :key="index" :style="barStyle(index - 1)"></span>
      </div>
</template>
