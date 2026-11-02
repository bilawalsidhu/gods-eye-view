<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../i18n/index.js';
import { useCctvStore } from '../stores/cctv.js';

// One click-to-type pose chip. The panel's delegated click starts an edit
// in CctvControls, which publishes it; the chip then holds a number input
// that ends the edit on Enter, blur or Escape.
const props = defineProps({
  field: { type: String, required: true },
  /** Message for the label shown before the first render. */
  label: { type: String, required: true },
});
const { view, calEdit } = storeToRefs(useCctvStore());
const edit = computed(() =>
  calEdit.value?.field === props.field ? calEdit.value : null,
);

// The draft is the user's once the input exists: the starting value is set
// on mount only, since re-renders would otherwise write it back.
const vDraft = {
  mounted(el, { value }) {
    el.value = value;
    el.focus();
    el.select();
  },
};

function onKeydown(event) {
  if (event.key === 'Enter') edit.value?.finish(true, event.target.value);
  else if (event.key === 'Escape') {
    event.preventDefault();
    edit.value?.finish(false);
  }
  event.stopPropagation();
}

function onBlur(event) {
  edit.value?.finish(true, event.target.value);
}
</script>

<template>
  <button
    class="cctv-cal-value"
    :data-cal-field="field"
    :disabled="edit ? false : view?.calibration.disabled"
    ><template v-if="edit"
      >{{ edit.label
      }}<input
        :key="edit.id"
        v-draft="edit.value"
        type="number"
        class="gev-field gev-field--inline cctv-cal-input"
        :step="edit.step"
        :aria-label="edit.ariaLabel"
        @keydown="onKeydown"
        @blur="onBlur"
        @click.stop /></template
    ><template v-else>{{
      view?.calibration.values[field] ?? `${t(label)} --`
    }}</template></button
  >
</template>
