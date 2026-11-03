<script setup>
import { computed, nextTick, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { useAgentConsoleStore } from '../stores/agentConsole.js';
import UiSelect from '../kit/UiSelect.js';
import { consoleTextParts, modelOptionLabel, providerOptionLabel, providerPrivacyText } from '../../agent/consolePresentation.js';
import { formatCommandCostUsd } from '../../agent/cost.js';

const { view, chatgpt } = storeToRefs(useAgentConsoleStore());
const providers = computed(() => (view.value?.providers ?? []).map(p => ({ value: p.id, label: providerOptionLabel(p) })));
const models = computed(() => (view.value?.models ?? []).map(m => ({ value: m.id, label: modelOptionLabel(m) })));
const accounts = computed(() => [
  ...(chatgpt.value?.accounts ?? []).map(a => ({ value: a.id, label: a.label })),
  { value: '', label: t('Add a ChatGPT account') },
]);
const status = computed(() => {
  const detail = view.value?.detail;
  const text = typeof detail === 'object' ? t(detail.key, detail.args) : t(detail || '');
  return t(view.value?.status || 'READY') + (text ? ` · ${text}` : '');
});
const statusCode = computed(() => (view.value?.status || 'READY').toLowerCase());
const privacy = computed(() => providerPrivacyText(view.value?.provider));
const plan = computed(() => view.value?.provider === 'chatgpt');
const cost = computed(() => plan.value ? t('ChatGPT plan limits') : formatCommandCostUsd(view.value?.models.find(m => m.id === view.value.model)?.costPerCommandUsd));
// Only geometry, native dialog disclosure, focus, input editing and scrolling
// remain imperative. The controller never builds children that Vue owns.
watch(() => view.value?.entries, async () => {
  await nextTick();
  const transcript = document.getElementById('agent-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
});
const parts = entry => entry.kind === 'tool' ? [{ text: entry.text, ltr: false }] : consoleTextParts(entry.text);
</script>

<template>
  <button id="agent-console-chip" type="button" :hidden="!view?.available" aria-haspopup="dialog" aria-controls="agent-console" :aria-expanded="String(view?.expanded ?? false)" :title="t('Type commands to the GEV agent')">
    <span class="agent-console-chip-caret" aria-hidden="true">&gt;_</span>
    <span translate="no">GEV COMMAND</span>
  </button>
  <!-- i18n-ignore: data-agent-status is an untranslated CSS machine code. -->
  <dialog id="agent-console" data-panel-surface aria-labelledby="agent-console-title" :data-agent-status="statusCode">
    <header data-panel-header>
      <h2 id="agent-console-title" class="panel-title panel-surface-title" translate="no">GEV COMMAND</h2>
      <div class="agent-console-selects">
        <label class="agent-console-field">
          <span>{{ t('PROVIDER') }}</span>
          <UiSelect id="agent-provider" class="panel-surface-control gev-field" :model-value="view?.provider" :options="providers" :disabled="view?.providerDisabled ?? true" />
        </label>
        <label class="agent-console-field">
          <span>{{ t('MODEL') }}</span>
          <UiSelect id="agent-model" class="panel-surface-control gev-field" :model-value="view?.model" :options="models" :disabled="view?.busy ?? true" />
        </label>
        <span id="agent-cost" class="agent-console-cost" :title="plan ? t('ChatGPT plan limits') : t('Estimated cost per command')">{{ cost }}</span>
      </div>
      <button id="agent-console-close" class="panel-surface-control agent-console-close" type="button" :aria-label="t('Close GEV Command')">×</button>
      <p v-if="privacy" id="agent-privacy" class="agent-console-privacy">{{ privacy }} {{ t('HUD captions use the separate summary provider configured for this app.') }}</p>
    </header>
    <div id="agent-chatgpt" class="agent-chatgpt" :hidden="!chatgpt?.visible">
      <label><span>{{ t('ChatGPT account') }}</span> <UiSelect id="agent-chatgpt-account" class="panel-surface-control gev-field" :model-value="chatgpt?.selected" :options="accounts" :disabled="chatgpt?.disabled ?? true" /></label>
      <button id="agent-chatgpt-login" type="button" class="panel-surface-control" :disabled="chatgpt?.disabled ?? true">{{ t('Continue with ChatGPT') }}</button>
      <button id="agent-chatgpt-logout" type="button" class="panel-surface-control" :disabled="chatgpt?.logoutDisabled ?? true">{{ t('Sign out / cancel sign-in') }}</button>
      <p id="agent-chatgpt-status" role="status">
        <a v-if="chatgpt?.signInPath" data-agent-sign-in :href="chatgpt.signInPath" target="_blank" rel="noopener noreferrer">{{ t('Continue with ChatGPT') }}</a>
        <template v-else>{{ chatgpt?.pending ? t('Complete sign-in in your browser.') : chatgpt?.error || (chatgpt?.connected ? t('ChatGPT account connected') : t('Sign in to use your ChatGPT plan.')) }}</template>
      </p>
      <p><span>{{ t('Uses your ChatGPT plan limits. Commands and tool results are sent to OpenAI.') }}</span> <a href="https://chatgpt.com/#settings" target="_blank" rel="noopener noreferrer">{{ t('ChatGPT Settings') }}</a></p>
    </div>
    <ol id="agent-transcript" class="ui-scroll" data-panel-body data-rail-scroller :aria-label="t('Command transcript')">
      <li v-for="(entry, index) in view?.entries ?? []" :key="index" :class="`agent-entry agent-entry-${entry.kind}`" :dir="entry.kind === 'tool' ? 'ltr' : 'auto'" :data-outcome="entry.outcome"><template v-for="(part, i) in parts(entry)" :key="i"><bdi v-if="part.ltr" dir="ltr">{{ part.text }}</bdi><template v-else>{{ part.text }}</template></template></li>
    </ol>
    <form id="agent-form" class="agent-console-form">
      <input id="agent-input" dir="auto" class="panel-surface-control" type="text" autocomplete="off" spellcheck="false" :disabled="view?.busy ?? true" :placeholder="t('zoom out to full planet view')" :aria-label="t('Typed command')" />
      <button id="agent-send" class="panel-surface-control" type="submit" :disabled="view?.busy ?? true">{{ t('SEND') }}</button>
      <button id="agent-stop" class="panel-surface-control" type="button" :disabled="view?.stopDisabled ?? true">{{ t('STOP') }}</button>
    </form>
    <p id="agent-status" class="agent-console-status" role="status" aria-live="polite">{{ status }}</p>
  </dialog>
</template>
