<script setup>
import { storeToRefs } from 'pinia';
import UiSelect from '../kit/UiSelect.js';
import { useCctvStore } from '../stores/cctv.js';

// The camera picker: the cameras in view and a closing note for those the
// view leaves out. It renders only when CctvControls publishes a picker,
// which re-applies the active camera, as on every layer notification. The
// opening camera, which follows the view until someone picks one, shows in a
// hidden first option: choosing that camera from the list is a change.
const { picker } = storeToRefs(useCctvStore());

// The selection, applied once the options are in place.
const pick = (el, { value: selection }) => {
  if (!selection) return;
  if ('value' in selection) {
    if (el.value !== selection.value) el.value = selection.value;
  } else if (el.selectedIndex !== selection.index)
    el.selectedIndex = selection.index;
};
const vPick = { mounted: pick, updated: pick };
</script>

<template>
  <UiSelect v-pick="picker?.selection" :disabled="picker?.disabled"
    ><option
      v-if="picker?.opening"
      value=""
      hidden
      disabled
      data-cctv-opening
      >{{ picker.opening }}</option
    ><option
      v-for="option in picker?.options"
      :key="option.value"
      :value="option.value"
      >{{ option.label }}</option
    ><option v-if="picker?.note" value="" disabled data-cctv-outside>{{
      picker.note
    }}</option></UiSelect
  >
</template>
