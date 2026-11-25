<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useDisplayStore } from '../../stores/display.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

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
      <UiButton v-for="tab in tabs" :key="tab.sheet" class="mobile-tab" :data-mobile-sheet="tab.sheet" :aria-expanded="String(phone.sheet === tab.sheet)"><UiIcon class="mobile-tab-icon" :name="tab.icon" :size="null" /><span class="mobile-tab-label">{{ t(tab.label) }}</span></UiButton>
    </nav>
  </Teleport>
</template>
