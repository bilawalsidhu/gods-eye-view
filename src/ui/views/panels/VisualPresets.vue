<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import { useDisplayStore } from '../../stores/display.js';

// The visual presets and map source at the top of the Visual panel. The same
// choices the command dock's tray offers, through the same Display store
// actions, so either surface stays in step with the other.
const display = useDisplayStore();
const { style, mapSource, mapSourceControls } = storeToRefs(display);

const STYLES = [
  { name: 'normal', icon: '◯', label: 'Normal', key: '1' },
  { name: 'retro', icon: '▦', label: 'CRT', key: '2' },
  { name: 'surveillance', icon: '🌙', label: 'NVG', key: '3' },
  { name: 'thermal', icon: '🌡️', label: 'FLIR', key: '4' },
  { name: 'anime', icon: '✦', label: 'Anime', key: '5' },
  { name: 'noir', icon: '◐', label: 'Noir', key: '6' },
];

function selectMapSource(chip) {
  if (!chip.available) return;
  void mapSourceControls.value?.select(chip.id).catch(() => {});
}
</script>

<template>
  <section class="visual-presets" :aria-label="t('VISUAL PRESETS')">
    <p class="visual-presets__heading">{{ t('Look') }}</p>
    <div class="visual-presets__grid">
      <UiButton
        v-for="preset in STYLES"
        :key="preset.name"
        class="visual-presets__style"
        :pressed="(style?.name ?? 'normal') === preset.name"
        pressed-class="active"
        :data-style="preset.name"
        @click="display.act('setStyle', preset.name)"
      >
        <span class="visual-presets__icon" aria-hidden="true">{{ preset.icon }}</span>
        <span class="visual-presets__label">{{ t(preset.label) }}</span>
        <kbd class="visual-presets__key">{{ preset.key }}</kbd>
      </UiButton>
    </div>
    <div class="visual-presets__heading visual-presets__heading--row">
      <span>{{ t('MAP SOURCE') }}</span>
      <span class="visual-presets__status" :class="{ warn: !!mapSource?.status.warn }">{{ mapSource ? mapSource.status.text : '3D' }}</span>
    </div>
    <div class="visual-presets__chips" role="group" :aria-label="t('Map source')">
      <UiButton
        v-for="chip in mapSource?.chips"
        :key="chip.id"
        class="visual-presets__chip"
        :class="{ unavailable: !chip.available }"
        :pressed="Boolean(chip.active)"
        pressed-class="active"
        :title="chip.title"
        :aria-disabled="String(!chip.available)"
        :aria-label="chip.ariaLabel"
        @click="selectMapSource(chip)"
        >{{ chip.label }}<small v-if="chip.requirement">{{ chip.requirement }}</small></UiButton
      >
    </div>
  </section>
</template>
