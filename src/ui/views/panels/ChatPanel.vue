<script setup>
import { nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useVoiceStore } from '../../stores/voice.js';
import { ASSISTANT_NAME } from '../../../voice/control.js';
import PanelLayoutButtons from './PanelLayoutButtons.vue';

// The typed chat in the command dock, as its owner (src/voice/chatControl.js)
// writes the voice control presenter. Messages arrive apart from the view, so
// a reply revealed frame by frame renders only this list.
const props = defineProps({ view: { type: Object, required: true } });
const store = useVoiceStore();
const { controls, chat: messages } = storeToRefs(store);
const emit = (name, ...args) => controls.value?.emit(name, ...args);
const list = ref(null);
const layerSelect = ref(null);
const layerChoice = ref('');

// The input holds what the person types until its owner writes it (history
// recall, a suggestion, clearing after send): only then is it replaced.
const vOwnedDraft = {
  mounted(el, { value }) {
    el.value = value.text;
  },
  updated(el, { value, oldValue }) {
    if (value.revision !== oldValue?.revision && el.value !== value.text)
      el.value = value.text;
  },
};

// Keep the newest message in view as the conversation grows, while the
// reader is at the bottom: one who scrolled up to read stays there until
// they send. The position is read on scroll, not on every reveal frame.
let stuck = true;
const onListScroll = () => {
  const el = list.value;
  if (el) stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
};
// A send is a new newest user message. The log is capped, so a full one
// does not grow as it takes a message: compare ids, not lengths.
const lastSent = (list) => list?.findLast((entry) => entry.role === 'user')?.id;
watch(messages, (next, previous) => {
  const sent =
    next.at(-1)?.role === 'user' && lastSent(next) !== lastSent(previous);
  if (!stuck && !sent) return;
  void nextTick(() => {
    if (list.value) list.value.scrollTop = list.value.scrollHeight;
  });
});

// Arrow keys only move the layer choice (a closed select changes on each
// press on Windows and Linux); the Attach button or Enter attaches it.
function attachLayer() {
  const value = layerChoice.value;
  layerChoice.value = '';
  if (layerSelect.value) layerSelect.value.value = '';
  if (value) emit('chat-layer', value);
}

const quickPrompts = () => [t('Fly to Tokyo'), t('Show live flights')];
</script>

<template>
  <section id="gev-chat-panel" :hidden="!props.view.chat.open" :data-minimized="props.view.chat.minimized ? 'true' : undefined" :aria-label="t('AI chat')">
    <header class="gev-chat-header">
      <div><strong>{{ t('GEV CHAT') }}</strong><p>{{ t('Ask about the map. Tell it where to go.') }}</p></div>
      <div id="gev-chat-header-actions">
        <PanelLayoutButtons :docked="props.view.layout.docked" :minimized="props.view.chat.minimized" @dock="emit('layout-dock')" @minimize="emit('chat-minimize')" />
        <button v-if="props.view.panel" id="gev-voice-settings-button" class="gev-voice-settings-button" type="button" :aria-label="t('Settings')" :title="t('Settings')" aria-controls="gev-voice-panel" :aria-expanded="String(props.view.voicePanel.settingsExpanded)" @click="emit('settings-button')"><span class="material-symbols-outlined gev-voice-settings-icon" aria-hidden="true">settings</span></button>
        <button id="gev-chat-close" type="button" :aria-label="t('Close chat')" @click="emit('chat-close')">×</button>
      </div>
    </header>
    <div id="gev-chat-messages" ref="list" role="log" :aria-label="t('Conversation')" aria-live="polite" :aria-busy="props.view.chat.busy || props.view.chat.revealing ? 'true' : undefined" @scroll.passive="onListScroll">
      <div id="gev-chat-empty" :hidden="!props.view.chat.empty">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><ellipse cx="12" cy="12" rx="4" ry="10"></ellipse><path d="M2 12h20"></path></svg>
        <h3>{{ t('Explore with a question') }}</h3>
        <p>{{ t('Find a place, explore live data, or change your view.') }}</p>
        <button v-for="prompt in quickPrompts()" :key="prompt" type="button" :hidden="!props.view.chat.quickChecked" @click="emit('chat-prompt', prompt)">{{ prompt }}</button>
      </div>
      <div v-for="message in messages" :key="message.id" class="gev-chat-message" :data-role="message.role">
        <small>{{ message.role === 'user' ? t('YOU') : ASSISTANT_NAME }}</small><span>{{ message.text }}</span>
      </div>
    </div>
    <p id="gev-chat-status" role="status">{{ props.view.chat.status }}</p>
    <!-- Stays under the status for the whole conversation. -->
    <p v-if="props.view.chat.authNote" id="gev-chat-auth-note">{{ props.view.chat.authNote }}</p>
    <div id="gev-chat-attachments" :aria-label="t('Attachments')" :hidden="!props.view.chat.attachments.length">
      <button v-for="item in props.view.chat.attachments" :key="item.key" type="button" :disabled="props.view.chat.locked" :aria-label="`${t('Remove attachment')}: ${item.name}`" @click="emit('chat-attachment-remove', item.key)">{{ item.name }} ×</button>
    </div>
    <div id="gev-chat-attach-menu" :hidden="!props.view.chat.attachMenuOpen" @keydown="emit('chat-attach-keydown', $event)">
      <label for="gev-chat-layer">{{ t('Attach a map layer') }}</label>
      <div id="gev-chat-layer-row">
        <select id="gev-chat-layer" ref="layerSelect" :disabled="props.view.chat.locked" @change="layerChoice = $event.target.value" @keydown.enter.prevent="attachLayer()">
          <option value="">{{ t('Choose a layer…') }}</option>
          <option v-for="layer in props.view.chat.layers" :key="layer.value" :value="layer.value">{{ layer.label }}</option>
        </select>
        <button id="gev-chat-layer-attach" type="button" :disabled="props.view.chat.locked || !layerChoice" @click="attachLayer()">{{ t('Attach layer') }}</button>
      </div>
      <button id="gev-chat-file-button" type="button" :disabled="props.view.chat.locked" @click="emit('chat-file-button')">{{ t('Attach a file') }}</button>
      <p>{{ t('TXT, Markdown, CSV, JSON or GeoJSON · up to 10 KB in total. Attachments are sent to your AI provider with your message.') }}</p>
      <input id="gev-chat-file" type="file" accept=".txt,.md,.csv,.json,.geojson" multiple hidden @change="emit('chat-files', $event.target)" />
    </div>
    <aside id="gev-chat-mini-reply" :hidden="!props.view.chat.miniReply" :aria-label="t('Latest AI response')">
      <header><span translate="no">{{ ASSISTANT_NAME }}</span><button id="gev-chat-expand-reply" type="button" :aria-label="t('Expand conversation')" :title="t('Expand conversation')" @click="emit('chat-restore')"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7"></path></svg></button></header>
      <p id="gev-chat-mini-text" aria-live="polite">{{ props.view.chat.miniReply }}</p>
    </aside>
    <div id="gev-chat-suggestions" :aria-label="t('Command suggestions')" :hidden="!props.view.chat.suggestions.length">
      <div v-for="group in props.view.chat.suggestions" :key="group.label">
        <small>{{ group.label }}</small>
        <button v-for="command in group.items" :key="command" type="button" :title="command" @click="emit('chat-suggestion', command)">{{ command }}</button>
      </div>
    </div>
    <form id="gev-chat-form" @submit.prevent="emit('chat-submit')">
      <button id="gev-chat-restore" type="button" :aria-label="t('Expand chat')" :title="t('Expand chat')" @click="emit('chat-restore')"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"></path></svg></button>
      <button id="gev-chat-attach" type="button" :disabled="props.view.chat.busy" :aria-label="t('Add attachment')" :aria-expanded="String(props.view.chat.attachMenuOpen)" aria-controls="gev-chat-attach-menu" @click="emit('chat-attach-toggle')" @keydown="emit('chat-attach-keydown', $event)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"></path></svg></button>
      <textarea id="gev-chat-input" v-owned-draft="{ text: props.view.chat.draft, revision: props.view.chat.draftRevision }" :rows="props.view.chat.rows" maxlength="4000" :aria-label="t('Message GEV')" :placeholder="t('Ask GEV anything about the map…')" @input="emit('chat-input', $event.target.value)" @keydown="emit('chat-keydown', $event)"></textarea>
      <button id="gev-chat-send" :type="props.view.chat.busy ? 'button' : 'submit'" :disabled="props.view.chat.sendDisabled" :data-busy="String(props.view.chat.busy)" :aria-label="props.view.chat.busy ? t('Stop reply') : t('Send message')" :title="props.view.chat.busy ? t('Stop reply') : t('Send message')" @click="props.view.chat.busy && emit('chat-stop')"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path class="gev-chat-enter-icon" d="M19 5v8H5m5-5-5 5 5 5"></path><rect class="gev-chat-stop-icon" x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"></rect></svg></button>
    </form>
  </section>
</template>
