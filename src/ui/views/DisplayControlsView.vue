<script setup>
import { useDisplayStore } from '../stores/display.js';
import DisplayPanel from './panels/DisplayPanel.vue';

const display = useDisplayStore();
</script>

<template>
  <DisplayPanel />
  <button id="clean-view-exit" @click="display.act('exitCleanView')" title="Return UI controls" data-i18n-title data-i18n>EXIT CLEAN VIEW</button>
</template>
