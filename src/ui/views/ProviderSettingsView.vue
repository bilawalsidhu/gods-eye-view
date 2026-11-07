<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { t } from '../../i18n/index.js';
import { vClassToggle } from '../rail/classToggle.js';
import { vFieldValue } from '../rail/fieldValue.js';
import { vStatusText } from '../rail/statusText.js';
import { useLocaleStore } from '../stores/locale.js';
import { useProviderSettingsStore } from '../stores/providerSettings.js';
import LocalePicker from './panels/LocalePicker.vue';

const { picker } = storeToRefs(useLocaleStore());
// The key setup owner (src/keySetup.js) presents the chip, the dialog and its
// rows; until it does, the chip stays hidden and the dialog closed. When the
// setup endpoint is not there, the owner reports it unavailable and both go.
const { view, controls } = storeToRefs(useProviderSettingsStore());
const available = computed(() => view.value?.available !== false);
const chip = computed(() => view.value?.chip ?? null);
const dialog = computed(() => view.value?.dialog ?? { hidden: true, visible: false });

// Cyber puts the chip in the top toolbar; every other theme keeps it first in
// the corner row, beside the language picker.
const cyber = shallowRef(false);
let themeObserver = null;
onMounted(() => {
  const theme = document.documentElement;
  const sync = () => {
    cyber.value =
      theme.dataset.uiTheme === 'cyber' &&
      Boolean(document.getElementById('top-center-actions'));
  };
  themeObserver = new MutationObserver(sync);
  themeObserver.observe(theme, { attributes: true, attributeFilter: ['data-ui-theme'] });
  sync();
});
onBeforeUnmount(() => themeObserver?.disconnect());

// The status line is a live region; vStatusText re-announces repeats.
const statusText = computed(() => ({
  text:
    view.value?.status ??
    t('The Google Maps key buys the photorealistic planet — everything else stacks on top.'),
  seq: view.value?.statusSeq ?? 0,
}));
const removeTitle = (title) =>
  t("Remove {title} from this app's saved keys", { title });
</script>

<template>
  <!-- POWER UP — in-app key setup. Dev-server only: src/keySetup.js reports
       it unavailable, removing both the chip and this dialog, when
       /api/setup/status is not there to answer (prod builds, LAN visitors).
       Rows are rendered from that payload, so the key registry lives in
       src/keySetupCore.mjs alone. -->
  <!-- Bottom-right HUD row: the POWER UP chip (while keys are missing) and
       the language picker, once the shell publishes it. -->
  <div id="corner-actions">
    <Teleport v-if="available" :to="cyber ? '#top-center-actions' : 'body'" :disabled="!cyber">
      <button id="key-setup-chip" type="button" :hidden="!chip || chip.hidden" aria-haspopup="dialog" aria-controls="key-setup" :title="chip?.title" :aria-label="chip?.title" @click="controls?.open()">
        <span class="material-symbols-outlined" aria-hidden="true">bolt</span>
        <span data-key-setup-chip-label>{{ chip ? chip.label : t('POWER UP') }}</span>
      </button>
    </Teleport>
    <LocalePicker v-if="picker" :key="picker.current" :current="picker.current" :on-select="picker.onSelect" :focus="picker.focus" />
  </div>
  <aside v-if="available" id="key-setup" role="dialog" aria-labelledby="key-setup-title" aria-describedby="key-setup-description" :hidden="dialog.hidden" v-class-toggle="{ visible: dialog.visible }" :data-ready="view?.ready ? 'true' : undefined" @transitionend="controls?.transitionEnd()">
    <div class="key-setup-scanline" aria-hidden="true"></div>
    <header class="key-setup-header">
      <span class="key-setup-kicker">{{ t('GROUND STATION · PROVIDER SETTINGS') }}</span>
      <button type="button" class="key-setup-close" data-key-setup-close :aria-label="t('Close key setup')" @click="controls?.close()">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </header>
    <h2 id="key-setup-title">{{ t('Power up the globe') }}</h2>
    <p id="key-setup-description">{{ t('The globe already flies keyless. Every key below switches on another real feed — paste one and it\'s saved into this app\'s local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.') }}</p>
    <div class="key-setup-rows ui-scroll" data-key-setup-rows>
      <section v-for="key in view?.rows ?? []" :key="`${key.id}:${view.generation}`" class="key-setup-row" :data-key-id="key.id" :data-set="String(key.set)" :data-managed="key.managed || undefined">
        <div class="key-setup-row-head">
          <span class="key-setup-led" aria-hidden="true"></span>
          <strong>{{ key.title }}</strong>
          <span class="key-setup-tier" :title="key.tierTitle">{{ key.tierDot }}</span>
          <span v-if="key.clientExposed" class="key-setup-exposed" :title="t('This key runs in the browser by design — restrict it at the provider (see SECURITY.md)')">{{ t('browser-side') }}</span>
          <span v-if="key.external" class="key-setup-external" :title="t('Supplied by your environment, Keychain, or launcher — change it where it was set')">{{ t('configured externally') }}</span>
          <a class="key-setup-get" :href="key.getUrl" target="_blank" rel="noopener noreferrer">{{ key.set ? t('MANAGE ↗') : t('GET KEY ↗') }}</a>
        </div>
        <p class="key-setup-unlocks">{{ key.unlocks }}</p>
        <div v-if="!key.external" class="key-setup-fields">
          <input v-for="envVar in key.envVars" :key="envVar" type="password" autocomplete="off" spellcheck="false" :data-env-var="envVar" :aria-label="envVar" :placeholder="key.set ? t('{envVar} saved — paste to replace', { envVar }) : t('paste {envVar}', { envVar })" v-field-value="view.fields[envVar] ?? ''" @input="controls?.setField(envVar, $event.target.value)" />
          <button v-if="key.managed === 'file'" type="button" class="key-setup-remove" :data-key-setup-remove="JSON.stringify(key.envVars)" :title="removeTitle(key.title)" @click="controls?.remove(key.envVars)">{{ t('REMOVE') }}</button>
        </div>
        <div v-if="key.id === 'openai'" class="key-setup-cloud-auth">
          <span class="key-setup-cloud-auth-state">{{ view.auth.mode === 'oauth' ? t('VOICE AUTH · CHATGPT OAUTH') : t('VOICE AUTH · API KEY') }}</span>
          <button type="button" class="key-setup-cloud-auth-toggle" data-cloud-voice-auth-toggle="true" :title="view.auth.mode === 'oauth' ? t('Use OPENAI_API_KEY for the next cloud voice session') : t('Use the signed-in local ChatGPT/Codex OAuth session for the next cloud voice session')" :aria-disabled="String(view.auth.busy)" @click="controls?.toggleAuth()">{{ view.auth.mode === 'oauth' ? t('USE API KEY') : t('USE CHATGPT OAUTH') }}</button>
        </div>
      </section>
    </div>
    <div class="key-setup-footer">
      <button type="button" class="key-setup-apply" data-key-setup-apply :aria-disabled="view?.saving == null ? undefined : String(view.saving)" @click="controls?.apply()">{{ t('SAVE KEYS') }}</button>
      <span class="key-setup-hint">{{ t('ESC to close') }}</span>
    </div>
    <p class="key-setup-note" data-key-setup-status role="status" aria-live="polite" v-status-text="statusText"></p>
  </aside>
</template>
