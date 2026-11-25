<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { vRootClass } from '../rail/rootClass.js';
import { usePointerReticleStore } from '../stores/pointerReticle.js';
import { useVoiceStore } from '../stores/voice.js';
import PhoneTabBar from './panels/PhoneTabBar.vue';
import VoiceControl from './panels/VoiceControl.vue';

// The voice control, while a voice session presents one. The Omnibar sits
// in its row between the microphone and chat (omnibar-dock.css).
const { view: voice } = storeToRefs(useVoiceStore());

// Where the user pointed while a voice turn is live (PointerReticle).
const { reticles } = storeToRefs(usePointerReticleStore());
</script>

<template>
  <!-- The command dock: the voice control, with the Omnibar in its row -->
  <div id="command-dock" class="ui-scroll" :aria-label="t('Voice and search controls')">
  <!-- The Omnibar's stylesheet selects on the voice control in the dock, and on voice being live, through classes on the page root (src/ui/rail/rootClass.js). -->
  <VoiceControl v-if="voice" :key="voice.id" :view="voice" v-root-class="{ 'dock-has-voice': true, 'assistant-voice-mode': voice.root.assistantMode === 'voice' }" />
  <PhoneTabBar />
  <Teleport to="body">
    <div v-for="reticle in reticles" :key="reticle.owner.key" class="gev-pointer-reticle" aria-hidden="true" :hidden="!reticle.visible" :data-target="reticle.target" :style="{ left: `${reticle.left}px`, top: `${reticle.top}px` }"></div>
  </Teleport>
  </div>
</template>
