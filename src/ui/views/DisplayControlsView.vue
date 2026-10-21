<script setup>
import { t } from '../../i18n/index.js';
import { useDisplayStore } from '../stores/display.js';
import DisplayPanel from './panels/DisplayPanel.vue';
import UiButton from '../kit/UiButton.vue';

const display = useDisplayStore();
</script>

<template>
  <DisplayPanel />
  <UiButton id="clean-view-exit" @click="display.act('exitCleanView')" :title="t('Return UI controls')">{{ t('EXIT CLEAN VIEW') }}</UiButton>
  <UiButton id="clean-view-eye" aria-pressed="false" @click="display.act('toggleCleanView')">
    <span class="clean-view-eye-icon" aria-hidden="true"></span>
  </UiButton>
</template>
