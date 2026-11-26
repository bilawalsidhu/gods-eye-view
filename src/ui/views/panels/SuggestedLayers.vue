<script setup>
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// Suggested layers: their names, then one Open that shows
// them in Data Layers picked out. Display only: a name switches nothing on.
defineProps({
  /** `[{id, name, icon}]`, from suggestLayers. */
  layers: { type: Array, required: true },
});
defineEmits(['open']);
</script>

<template>
  <div v-if="layers.length" class="view-context__suggest">
    <h4 class="view-context__label">{{ t('Suggested layers') }}</h4>
    <p class="view-context__suggest-row">
      <span v-for="layer in layers" :key="layer.id" class="view-context__suggest-item" :data-layer="layer.id">
        <UiIcon :name="layer.icon" :size="null" />{{ layer.name }}
      </span>
    </p>
    <UiButton class="view-context__pointer view-context__suggest-open" @click="$emit('open')">
      <UiIcon name="layers" :size="null" />
      <span class="view-context__pointer-text">{{ t('See them in Data Layers') }}</span>
      <span class="view-context__pointer-go">{{ t('Open') }} ›</span>
    </UiButton>
  </div>
</template>
