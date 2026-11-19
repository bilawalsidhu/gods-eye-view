<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import { useDataLibraryStore } from '../../stores/dataLibrary.js';
import DataLibraryDialog from './DataLibraryDialog.vue';

// DATA LAYERS ▸ Browse data library: the button at the foot of the panel and
// the dialog it opens, drawn once the library browser (src/ui/libraryBrowser.js)
// publishes. Kept apart from LayerPanelsView so the browser's publishes (the
// stat tiles refresh every second while open) re-render only this.
const { view, controls } = storeToRefs(useDataLibraryStore());
</script>

<template>
  <div class="data-library-footer">
    <UiButton
      id="data-library-browse"
      class="data-library-browse"
      aria-haspopup="dialog"
      aria-controls="data-library"
      :hidden="!view"
      :native-title="false"
      @click="controls?.open()"
      >{{ t('BROWSE DATA LIBRARY') }}</UiButton
    >
  </div>
  <Teleport v-if="view" to="body"><DataLibraryDialog :view="view" /></Teleport>
</template>
