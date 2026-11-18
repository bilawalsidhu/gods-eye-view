<script setup>
import { storeToRefs } from 'pinia';
import { formatNumber, t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { useVoiceStore } from '../../stores/voice.js';
import { ASSISTANT_NAME } from '../../../voice/control.js';
import VoiceCard from './VoiceCard.vue';
import VoiceVisualizer from './VoiceVisualizer.vue';
import ChatPanel from './ChatPanel.vue';
import PanelLayoutButtons from './PanelLayoutButtons.vue';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';

// The voice control in the command dock, as its presenter
// (src/voice/control.js) holds it. The session owners write the presenter;
// this renders it and reports what the person does.
defineProps({ view: { type: Object, required: true } });
const { controls } = storeToRefs(useVoiceStore());
const emit = (name, ...args) => controls.value?.emit(name, ...args);

// A value the owner may restore after a refused change; written on every
// render, as the owner's own writes were.
const vChecked = {
  mounted(el, { value }) {
    el.checked = value;
  },
  updated(el, { value }) {
    if (el.checked !== value) el.checked = value;
  },
};
// The minutes field holds a draft until it changes: write it only when its
// owner does, not on every render (the waveform renders each frame).
const vOwnedValue = {
  mounted(el, { value }) {
    el.value = value.text;
  },
  updated(el, { value, oldValue }) {
    if (value.revision !== oldValue?.revision && el.value !== value.text)
      el.value = value.text;
  },
};
// "5 minutes" in the UI language, with the count's plural form ("15 دقيقة").
const minutesLabel = (count) =>
  formatNumber(count, { style: 'unit', unit: 'minute', unitDisplay: 'long' });
const optional = (value) => (value == null ? undefined : String(value));
// The root's machine-state attributes, which the dock and theme CSS select on.
const rootData = (root) => ({
  'data-status': root.status,
  'data-speaker': root.speaker,
  'data-provider': optional(root.provider),
  'data-provider-choice': optional(root.providerChoice),
  'data-push-to-talk': optional(root.pushToTalk),
  'data-microphone': optional(root.microphone),
  'data-row-grace': root.rowGrace ? 'true' : undefined,
  'data-assistant-mode': root.assistantMode,
  'data-chat-open': String(root.chatOpen),
  'data-chat-busy': String(root.chatBusy),
  'data-voice-exchange': root.voiceExchange ? 'true' : undefined,
});
// Settings opened from chat take chat's frame, so the switch does not jump.
const frameStyle = (panel) => ({
  '--chat-frame-width': panel.frameWidth ? `${panel.frameWidth}px` : undefined,
  '--chat-frame-height': panel.frameHeight ? `${panel.frameHeight}px` : undefined,
});
</script>

<template>
  <div id="gev-voice-control" v-bind="rootData(view.root)" v-class-toggle="{ 'error-dismissed': view.root.errorDismissed }" @pointerleave="emit('pointerleave', $event)" @pointerenter="emit('pointerenter', $event)">
      <span class="gev-active-border" aria-hidden="true"></span>
      <label v-if="!view.panel" id="gev-voice-provider-field" class="gev-voice-provider-field" :hidden="view.provider.hidden">
        <span>{{ t('Voice provider') }}</span>
        <UiSelect id="gev-voice-provider" class="gev-field" :aria-label="t('Voice provider')" :title="view.provider.title" :model-value="view.provider.value" @update:model-value="emit('provider-change', $event)"><option v-for="option in view.provider.options" :key="option.value" :value="option.value">{{ option.label }}</option></UiSelect>
      </label>
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker">{{ t('AI AGENT') }}</div>
        <div id="gev-voice-status">{{ view.status.text }}</div>
        <span v-if="view.panel" id="gev-voice-cost-warning" class="gev-voice-cost-value gev-voice-cost-warning" :hidden="view.costWarning.hidden" :title="optional(view.costWarning.title)" :data-level="optional(view.costWarning.level)" role="status" aria-live="polite">{{ view.costWarning.text }}</span>
        <div v-else class="gev-voice-cost">
          <UiButton id="gev-voice-tier" class="gev-voice-tier-btn" :hidden="view.tier.hidden" :pressed="Boolean(view.tier.pressed)" :title="view.tier.title" @click="emit('tier')">{{ view.tier.text }}</UiButton>
          <span id="gev-voice-cost-value" class="gev-voice-cost-value" :hidden="view.cost.hidden" :data-level="view.cost.level" :title="view.cost.title">{{ view.cost.text }}</span>
        </div>
      </div>
      <UiButton id="gev-voice-button" :aria-label="view.button.label" :pressed="view.button.pressed ?? undefined" aria-describedby="gev-voice-help" @click="emit('button')">
        <span class="gev-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="gev-mic-label">{{ view.mic.text }}</span>
      </UiButton>
      <button v-if="view.panel" id="gev-chat-button" type="button" :aria-label="t('Open AI chat')" aria-controls="gev-chat-panel" :aria-expanded="String(view.chat.open && !view.chat.minimized)" @click="emit('chat-button')"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"></path></svg><span class="gev-chat-label">{{ t('CHAT') }}</span></button>
      <ChatPanel v-if="view.panel" :view="view" />
      <VoiceVisualizer />
      <div class="gev-chat-thinking" aria-hidden="true"><span></span><span></span><span></span></div>
      <!-- Chat announces its phase in its own status line (#gev-chat-status); in chat mode this one stays silent. -->
      <div id="gev-assistant-phase" role="status" :aria-live="view.root.assistantMode === 'chat' ? 'off' : 'polite'" :aria-hidden="view.root.assistantMode === 'chat' ? 'true' : undefined">{{ view.phase.text }}</div>
      <div class="gev-voice-readout">
        <div id="gev-voice-detail" :title="optional(view.detail.title)">{{ view.detail.text }}</div>
      </div>
      <div id="gev-voice-help" class="gev-voice-help-tray" role="tooltip">
        <span class="gev-voice-help-kicker">{{ t('VOICE CONTROL') }}</span>
        <span class="gev-voice-help-detail">{{ view.help.text }}</span>
      </div>
      <section v-if="view.panel" id="gev-voice-panel" class="gev-voice-panel" :hidden="view.voicePanel.hidden" :data-view="optional(view.voicePanel.view)" :data-minimized="view.voicePanel.minimized ? 'true' : undefined" :data-context="optional(view.voicePanel.context)" :style="frameStyle(view.voicePanel)" :aria-label="t('Voice Settings')" @keydown="emit('panel-keydown', $event)">
        <div class="gev-voice-panel-header">
          <button id="gev-chat-back" type="button" :hidden="!view.chat.backVisible" @click="emit('chat-back')"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg><span>{{ t('Back to chat') }}</span></button>
          <button id="gev-voice-back" type="button" @click="emit('voice-back')"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg><span>{{ t('Back to voice') }}</span></button>
          <span class="gev-voice-panel-title">{{ t('VOICE') }}</span>
          <div class="gev-voice-panel-tabs" role="tablist" :aria-label="t('Voice Settings')">
            <button id="gev-voice-preview-tab" class="gev-voice-panel-tab" type="button" role="tab" :aria-label="t('Preview')" :title="t('Preview')" :aria-selected="String(view.voicePanel.selected === 'preview')" :tabindex="view.voicePanel.selected === 'preview' ? 0 : -1" aria-controls="gev-voice-preview-panel" @click="emit('tab', 0)" @keydown="emit('tab-keydown', 0, $event)"><span class="material-symbols-outlined gev-voice-panel-tab-icon" aria-hidden="true">visibility</span></button>
            <button id="gev-voice-settings-tab" class="gev-voice-panel-tab" type="button" role="tab" :aria-label="t('Settings')" :title="t('Settings')" :aria-selected="String(view.voicePanel.selected === 'settings')" :tabindex="view.voicePanel.selected === 'settings' ? 0 : -1" aria-controls="gev-voice-settings-panel" @click="emit('tab', 1)" @keydown="emit('tab-keydown', 1, $event)"><span class="material-symbols-outlined gev-voice-panel-tab-icon" aria-hidden="true">settings</span></button>
          </div>
          <PanelLayoutButtons :docked="view.layout.docked" :minimized="view.voicePanel.minimized" @dock="emit('layout-dock')" @minimize="emit('voice-minimize')" />
          <button id="gev-voice-settings-close" type="button" :aria-label="t('Close voice panel')" @click="emit('settings-close')">×</button>
        </div>
        <div class="gev-voice-mini" role="group" :aria-label="t('Latest voice exchange')">
          <p :hidden="!view.mini.user"><span class="gev-voice-mini-who">{{ t('YOU') }}</span><span id="gev-voice-mini-user">{{ view.mini.user }}</span></p>
          <p :hidden="!view.mini.assistant"><span class="gev-voice-mini-who" translate="no">{{ ASSISTANT_NAME }}</span><span id="gev-voice-mini-assistant">{{ view.mini.assistant }}</span></p>
        </div>
        <div class="gev-voice-panel-body ui-scroll">
          <section id="gev-voice-preview-panel" role="tabpanel" aria-labelledby="gev-voice-preview-tab" :hidden="view.voicePanel.previewHidden">
            <p id="gev-voice-preview-empty" :hidden="view.previewEmpty.hidden">{{ view.previewEmpty.text }}</p>
            <div class="gev-voice-hints" role="group" :aria-label="t('Try saying')"><small>{{ t('Try saying') }}</small><q>{{ t('What am I looking at?') }}</q><q>{{ t('Fly to Tokyo') }}</q><q>{{ t('Show live flights') }}</q></div>
      <VoiceCard :card="view.card" @dismiss="emit('card-dismiss')" />
          </section>
          <section id="gev-voice-settings-panel" role="tabpanel" aria-labelledby="gev-voice-settings-tab" :hidden="view.voicePanel.settingsHidden">
            <label id="gev-voice-provider-field" class="gev-voice-provider-field" :hidden="view.provider.hidden">
              <span>{{ t('AI Provider') }}</span>
              <UiSelect id="gev-voice-provider" class="gev-field" :aria-label="t('AI Provider')" :title="view.provider.title" :model-value="view.provider.value" @update:model-value="emit('provider-change', $event)"><option v-for="option in view.provider.options" :key="option.value" :value="option.value">{{ option.label }}</option></UiSelect>
            </label>
            <p class="gev-voice-settings-note">{{ t('The selected AI provider is shared by voice and chat.') }}</p>
            <div id="gev-settings-chat">
              <label class="gev-voice-preference gev-voice-preference-toggle"><input id="gev-chat-quick" type="checkbox" v-checked="view.chat.quickChecked" @change="emit('chat-quick-change', $event.target.checked)" /><span>{{ t('Show quick commands') }}</span></label>
              <p>{{ t('Chat replies are silent. No microphone access is needed.') }}</p>
            </div>
            <div id="gev-settings-voice">
            <label class="gev-voice-preference gev-voice-preference-toggle"><input id="gev-voice-preview-enabled" type="checkbox" aria-describedby="gev-voice-preview-note" v-checked="view.preferences.previewChecked" @change="emit('preview-change', $event.target.checked)" /><span>{{ t('Show Voice Preview') }}</span></label>
            <p id="gev-voice-preview-note" class="gev-voice-settings-note">{{ view.preferences.previewNote }}</p>
            <div class="gev-voice-timeout-group">
            <label class="gev-voice-preference gev-voice-setting-title" for="gev-voice-timeout-select">{{ t('Voice inactivity timeout') }}</label>
            <div class="gev-voice-timeout-controls">
            <UiSelect id="gev-voice-timeout-select" class="gev-field" aria-describedby="gev-voice-timeout-note gev-voice-timeout-status" :model-value="view.preferences.timeoutChoice" @update:model-value="emit('timeout-select', $event)">
              <option value="3">{{ minutesLabel(3) }}</option><option value="5">{{ minutesLabel(5) }}</option><option value="10">{{ minutesLabel(10) }}</option><option value="15">{{ minutesLabel(15) }}</option>
              <option value="custom">{{ t('Custom') }}</option><option value="0">{{ t('None') }}</option>
            </UiSelect>
            <label class="gev-voice-timeout-unit" for="gev-voice-timeout-input">{{ t('Minutes') }}</label>
            <input id="gev-voice-timeout-input" type="number" min="1" max="60" step="1" aria-describedby="gev-voice-timeout-note" v-owned-value="{ text: view.preferences.timeoutMinutes, revision: view.preferences.revision }" :hidden="view.preferences.timeoutInputHidden" @change="emit('timeout-input', $event.target.value)" />
            </div>
            <p id="gev-voice-timeout-note" class="gev-voice-settings-note">{{ view.preferences.timeoutNote }}</p>
            <p id="gev-voice-timeout-status" class="gev-voice-settings-note" role="status" aria-live="polite">{{ view.preferences.timeoutStatus }}</p>
            </div>
            <div class="gev-voice-cost-settings">
              <div class="gev-voice-cost-setting-row">
                <span>{{ t('Voice model tier — applies next session') }}</span>
                <UiButton id="gev-voice-tier" class="gev-voice-tier-btn" :hidden="view.tier.hidden" :pressed="Boolean(view.tier.pressed)" :title="view.tier.title" @click="emit('tier')">{{ view.tier.text }}</UiButton>
              </div>
              <div class="gev-voice-cost-setting-row">
                <span>{{ t('Estimated session cost') }}</span>
                <span id="gev-voice-cost-value" class="gev-voice-cost-value" :hidden="view.cost.hidden" :data-level="view.cost.level" :title="view.cost.title">{{ view.cost.text }}</span>
              </div>
            </div>
            </div>
          </section>
        </div>
      </section>
      <VoiceCard v-else :card="view.card" @dismiss="emit('card-dismiss')" />
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span>{{ view.error.typed ? `${t('Chat')} · ${t('ERROR', { context: 'voice' })}` : t('VOICE SYSTEM ERROR') }}</span>
          <button class="gev-voice-error-dismiss" type="button" @click="controls?.dismissError()">{{ t('DISMISS') }}</button>
        </div>
        <div id="gev-voice-error-detail">{{ view.error.text }}</div>
        <div class="gev-voice-error-hint" :hidden="view.error.typed || view.error.hint === false">{{ t('Check microphone permission and network access, then try again.') }}</div>
      </div>
  </div>
</template>
