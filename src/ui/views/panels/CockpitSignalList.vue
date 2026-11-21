<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { vFocusSafeChildren } from '../../rail/focusSafeChildren.js';
import { useCockpitStore } from '../../stores/cockpit.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// The Cockpit's live signal rows. The Cockpit controller presents them;
// until it does, the list is empty. Rows reorder several times a second,
// so the list keeps keyboard focus on its row while the others move, and
// moves focus to `leave` before the focused row goes. Selection stays with
// the controller's click listener. The template is one line: templates keep
// whitespace.
defineProps({
  leave: { type: Function, required: true },
});
const { signals } = storeToRefs(useCockpitStore());
const rows = computed(() => signals.value ?? []);
</script>

<template>
  <ol id="cockpit-signal-list" v-focus-safe-children="leave" class="cockpit-signal-list" aria-live="polite"><li v-for="row in rows" :key="row.key" :class="row.className" :data-signal-key="row.key"><time>{{ row.time }}</time><div><UiButton v-if="row.target" class="cockpit-signal-target" :data-signal-layer="row.target.layerId" :data-signal-id="row.target.id" :aria-label="row.target.label"><span class="cockpit-signal-target-label">{{ row.title }}</span><span class="cockpit-signal-target-rule" aria-hidden="true"></span><UiIcon name="chevron_right" class="cockpit-signal-target-chevron" :size="null" /></UiButton><strong v-else>{{ row.title }}</strong><span>{{ row.detail }}</span></div></li></ol>
</template>
