<script setup>
import { t } from '../../../i18n/index.js';
import { ASSISTANT_NAME } from '../../../voice/control.js';
import UiChip from '../../kit/UiChip.vue';

// Captions, plan and result, as VoiceCardControls (src/voice/voiceCard.js)
// presents them. Captions update silently; the polite live region carries
// final replies and result titles only.
defineProps({ card: { type: Object, required: true } });
const emit = defineEmits(['dismiss']);
</script>

<template>
  <section id="gev-voice-card" class="gev-voice-card ui-scroll" :hidden="!card.visible" :data-busy="card.busy == null ? undefined : String(card.busy)" :aria-label="t('Voice assistant')">
        <div class="gev-voice-card-header">
          <span class="gev-voice-card-kicker">{{ t('VOICE') }}</span>
          <span id="gev-voice-card-phase" class="gev-voice-card-phase">{{ card.phase }}</span>
          <button id="gev-voice-card-dismiss" class="gev-voice-card-dismiss" type="button" :aria-label="t('Dismiss voice card')" @click="emit('dismiss')">×</button>
        </div>
        <p id="gev-voice-card-user" class="gev-voice-card-caption" data-role="user" :hidden="!card.user.visible"><span id="gev-voice-card-user-who" class="gev-voice-card-who">{{ card.user.label }}</span><span id="gev-voice-card-user-text" class="gev-voice-card-text">{{ card.user.text }}</span></p>
        <p id="gev-voice-card-pointer" class="gev-voice-card-pointer" :hidden="!card.pointer.visible"><span id="gev-voice-card-pointer-kind" class="gev-voice-card-who">{{ card.pointer.kind }}</span><span class="gev-voice-card-sr">: </span><span id="gev-voice-card-pointer-text" class="gev-voice-card-pointer-label">{{ card.pointer.text }}</span></p>
        <p id="gev-voice-card-assistant" class="gev-voice-card-caption" data-role="assistant" :hidden="!card.assistant.visible"><span class="gev-voice-card-who">{{ ASSISTANT_NAME }}</span><span id="gev-voice-card-assistant-text" class="gev-voice-card-text">{{ card.assistant.text }}</span></p>
        <ol id="gev-voice-card-plan" class="gev-voice-card-plan" :aria-label="t('Plan')" :hidden="card.steps.length === 0"><li v-for="(step, index) in card.steps" :key="step.key ?? index" class="gev-voice-card-step" :data-status="step.status"><span class="gev-voice-card-step-label">{{ step.label }}</span><span class="gev-voice-card-sr">{{ step.statusText ? `, ${step.statusText}` : '' }}</span><span v-if="step.detail" class="gev-voice-card-step-detail">{{ step.detail }}</span></li></ol>
        <div id="gev-voice-card-result" class="gev-voice-card-result" :hidden="!card.result.visible">
          <div id="gev-voice-card-result-title" class="gev-voice-card-result-title">{{ card.result.title }}</div>
          <div id="gev-voice-card-chips" class="gev-voice-card-chips" :hidden="card.result.chips.length === 0"><UiChip v-for="(chip, index) in card.result.chips" :key="index" class="gev-voice-card-chip" :data-tone="chip">{{ chip }}</UiChip></div>
          <ul id="gev-voice-card-lines" class="gev-voice-card-lines"><li v-for="(line, index) in card.result.lines" :key="index">{{ line }}</li></ul>
          <ol id="gev-voice-card-referents" class="gev-voice-card-referents" :aria-label="t('Referenced items')" :hidden="card.result.referents.length === 0"><li v-for="(ref, index) in card.result.referents" :key="index" :value="ref.n">{{ ref.label }}</li></ol>
          <details id="gev-voice-card-notes" class="gev-voice-card-notes" :hidden="card.result.notes.length === 0">
            <summary>{{ t('NOTES & SOURCES') }}</summary>
            <ul id="gev-voice-card-note-list" class="gev-voice-card-lines"><li v-for="(note, index) in card.result.notes" :key="index">{{ note }}</li></ul>
          </details>
        </div>
        <div id="gev-voice-card-live" class="gev-voice-card-sr" aria-live="polite" aria-atomic="true">{{ card.announce }}</div>
      </section>
</template>
