<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useDisplayStore } from '../../stores/display.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// The phone shell's tab bar and sheet backdrop. They join the end of the
// page when the shell first publishes, after the scene's credits, and leave
// it when the shell is destroyed; desktop CSS hides them meanwhile.
// Space Missions has no phone tab of its own. Its list is in Context's Inspect view.
const { phoneShell: phone } = storeToRefs(useDisplayStore());
</script>

<template>
  <Teleport v-if="phone" to="body">
    <div id="mobile-sheet-backdrop" :hidden="!phone.sheet"></div>
    <nav id="mobile-tab-bar" :aria-label="t('Panels')" :aria-hidden="String(!phone.enabled)">
      <UiButton v-for="tab in phone.tabs" :key="tab.sheet" class="mobile-tab" :data-mobile-sheet="tab.sheet" :aria-expanded="String(phone.sheet === tab.sheet)"><UiIcon class="mobile-tab-icon" :name="tab.icon" :size="null" /><span class="mobile-tab-label">{{ t(tab.label) }}</span></UiButton>
    </nav>
  </Teleport>
</template>
