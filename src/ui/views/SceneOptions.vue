<script setup>
import { storeToRefs } from 'pinia';
import { getCurrentInstance, watch } from 'vue';
import { useSceneStore } from '../stores/scenes.js';

// The Scene select's options; selecting one stays with SceneControls.
const { scenes, listedSceneId, listedRevision } = storeToRefs(useSceneStore());

// Every option render shows the published scene, as the select did before:
// `selected` alone is written only when it changes, so it would leave a
// person's later pick standing.
const instance = getCurrentInstance();
watch(
  listedRevision,
  () => {
    const select = instance.proxy.$el?.parentNode;
    if (select && listedSceneId.value) select.value = listedSceneId.value;
  },
  { flush: 'post' },
);
</script>

<template>
  <option
    v-for="scene in scenes"
    :key="scene.id"
    :value="scene.id"
    :selected="scene.id === listedSceneId"
    >{{ scene.title }}</option
  >
</template>
