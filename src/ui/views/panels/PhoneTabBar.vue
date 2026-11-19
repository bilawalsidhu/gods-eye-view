<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useDisplayStore } from '../../stores/display.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';

// The phone shell's tab bar and sheet backdrop. They join the end of the
// page when the shell first publishes, after the scene's credits, and leave
// it when the shell is destroyed; desktop CSS hides them meanwhile.
const { phoneShell: phone } = storeToRefs(useDisplayStore());
const { enabled: missionsEnabled } = storeToRefs(useSpaceMissionsStore());
const tabs = computed(() =>
  phone.value?.tabs.filter((tab) => tab.sheet !== 'missions' || missionsEnabled.value),
);
</script>

<template>
  <Teleport v-if="phone" to="body">
    <div id="mobile-sheet-backdrop" :hidden="!phone.sheet"></div>
    <nav id="mobile-tab-bar" :aria-label="t('Panels')" :aria-hidden="String(!phone.enabled)">
      <button v-for="tab in tabs" :key="tab.sheet" type="button" class="mobile-tab" :data-mobile-sheet="tab.sheet" :aria-expanded="String(phone.sheet === tab.sheet)"><span class="material-symbols-outlined mobile-tab-icon" aria-hidden="true">{{ tab.icon }}</span><span class="mobile-tab-label">{{ t(tab.label) }}</span></button>
    </nav>
  </Teleport>
</template>
