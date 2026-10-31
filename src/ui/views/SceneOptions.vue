<script setup>
import { storeToRefs } from 'pinia';
import { useSceneStore } from '../stores/scenes.js';

// The Scene select's options; selecting one stays with SceneControls.
const { scenes, listedSceneId } = storeToRefs(useSceneStore());
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
