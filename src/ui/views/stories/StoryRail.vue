<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useStoriesStore } from '../../stores/stories.js';

/**
 * The right rail over the story map (prototype `.ov-rail`): Open in GEV (it
 * opens the scene in GEV's Scenes panel) and Share.
 */
const store = useStoriesStore();
// A scene saved on this device only: a link to it opens nothing elsewhere.
const localOnly = computed(() => !!store.byId(store.storyId)?.mine);

async function share() {
  const url = store.controller.shareLink();
  try {
    await navigator.clipboard.writeText(url);
    store.flashHint(t('Story link copied'), 1800);
  } catch {
    store.flashHint(url, 2600);
  }
}
</script>

<template>
  <div id="ovRail" class="ov ov-rail">
    <!-- The scene opens in GEV's Scenes panel. -->
    <button
      id="railGev"
      class="rail-btn rail-gev"
      type="button"
      :aria-label="t('Open this moment in GEV')"
      @click="store.controller.openInGev()"
    >
      <span class="ic"
        ><svg class="eye" viewBox="0 0 775 520" aria-hidden="true">
          <use href="#gevLogo" /></svg></span
      >{{ t('Open') }}
    </button>
    <button
      v-if="!localOnly"
      id="railShare"
      class="rail-btn"
      type="button"
      :aria-label="t('Share this story')"
      @click="share"
    >
      <span class="ic"
        ><span class="share-icon" aria-hidden="true">&#x1F517;</span></span
      >{{ t('Share') }}
    </button>
  </div>
</template>
