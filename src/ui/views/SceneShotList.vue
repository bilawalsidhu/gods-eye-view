<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { describeShot } from '../scenePresentation.js';
import UiButton from '../kit/UiButton.vue';
import { useSceneStore } from '../stores/scenes.js';
import UiEmpty from '../kit/UiEmpty.vue';

// The selected scene's shots. Rows keep their identity across selection so a
// click followed by a double-click lands on the same label.
const store = useSceneStore();
const { scenes, selectedSceneId, selectedShotId, attached } =
  storeToRefs(store);
const scene = computed(
  () => scenes.value.find((item) => item.id === selectedSceneId.value) ?? null,
);
/** The row being renamed, with the scene it was shown in. */
const editing = ref(null);
const renameInput = ref(null);

// A rename ends with its row: another scene, a deleted shot or no owner.
watch([scene, attached], () => {
  if (
    editing.value &&
    !(
      attached.value &&
      scene.value?.id === editing.value.sceneId &&
      scene.value.shots.some((shot) => shot.id === editing.value.shotId)
    )
  )
    editing.value = null;
});

// Built-in titles arrive localized as displayTitle; the stored title stays
// English, so a rename happens only when the shown text changes.
const shownTitle = (shot) => shot.displayTitle || shot.title;
const isEditing = (shot) => editing.value?.shotId === shot.id;

function act(name, shot, ...args) {
  if (scene.value) store.act(name, scene.value.id, shot.id, ...args);
}

async function startRename(shot) {
  if (isEditing(shot) || !scene.value) return;
  editing.value = { sceneId: scene.value.id, shotId: shot.id };
  await nextTick();
  const input = renameInput.value?.[0];
  if (!input) return;
  // Set once: a re-render while typing keeps what was typed.
  input.value = shownTitle(shot);
  input.focus();
  input.select();
}

function finishRename(shot, input, save) {
  const rename = editing.value;
  if (rename?.shotId !== shot.id) return;
  editing.value = null;
  const title = input.value.trim();
  if (save && title && title !== shownTitle(shot))
    store.act('rename', rename.sceneId, shot.id, title);
}

function onRenameKey(shot, event) {
  event.stopPropagation();
  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault();
    finishRename(shot, event.target, event.key === 'Enter');
  }
}
</script>

<template>
  <div id="scene-shot-list" class="scene-shot-list ui-scroll">
    <template v-if="attached">
      <UiEmpty
        v-if="!scene?.shots.length"
        class="scene-shot-empty"
        :title="t('No shots yet. Use CAPTURE SHOT to save current look.')"
      />
      <template v-else>
        <div
          v-for="shot in scene.shots"
          :key="shot.id"
          class="scene-shot-row"
          :class="{ active: shot.id === selectedShotId }"
          :data-scene-shot-id="shot.id"
        >
          <div class="scene-shot-top">
            <div
              class="scene-shot-label"
              :title="t('Double-click to rename')"
              @click="store.act('select', shot.id)"
              @dblclick="startRename(shot)"
              ><input
                v-if="isEditing(shot)"
                ref="renameInput"
                type="text"
                class="scene-shot-rename"
                :aria-label="t('Shot name')"
                @keydown="onRenameKey(shot, $event)"
                @blur="finishRename(shot, $event.target, true)"
              /><template v-else>{{ shownTitle(shot) }}</template></div
            >
            <div class="scene-shot-actions">
              <UiButton
                class="gev-action-button gev-action-button--compact scene-shot-btn"
                @click="act('load', shot)"
                >{{ t('LOAD') }}</UiButton
              >
              <UiButton
                tone="alert"
                class="gev-action-button gev-action-button--danger gev-action-button--compact scene-shot-btn scene-shot-danger"
                @click="act('remove', shot)"
                >{{ t('DEL') }}</UiButton
              >
            </div>
          </div>
          <div class="scene-shot-meta">{{ describeShot(shot) }}</div>
        </div>
      </template>
    </template>
  </div>
</template>
