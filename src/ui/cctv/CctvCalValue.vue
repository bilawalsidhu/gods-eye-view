<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../i18n/index.js';
import { useCctvStore } from '../stores/cctv.js';
import UiButton from '../kit/UiButton.vue';

// One click-to-type pose chip. The panel's delegated click starts an edit
// in CctvControls, which publishes it; the chip then holds a number input
// that ends the edit on Enter, blur or Escape. Escape there cancels the edit
// alone (data-owns-escape): Context leaves it be rather than close the card.
const props = defineProps({
  field: { type: String, required: true },
  /** Message for the label shown before the first render. */
  label: { type: String, required: true },
  /** The number alone: a label beside it already names the field. */
  bare: { type: Boolean, default: false },
  /** With `bare`, the id of that label: the chip is named by it and its number. */
  labelId: { type: String, default: '' },
  /** The typed value's name, its unit included; the field code without one. */
  inputLabel: { type: String, default: '' },
});
const valueId = computed(() =>
  props.bare && props.labelId ? `cctv-cal-value-${props.field}` : undefined,
);
const { view, calEdit } = storeToRefs(useCctvStore());
const edit = computed(() =>
  calEdit.value?.field === props.field ? calEdit.value : null,
);

const estimatedLabel = computed(() =>
  props.field === 'heading' && !edit.value
    ? view.value?.calibration.estimatedHeadingLabel
    : undefined,
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
  <UiButton
    class="cctv-cal-value"
    :id="valueId"
    :data-cal-field="field"
    :label="estimatedLabel"
    :aria-labelledby="
      !estimatedLabel && valueId ? `${labelId} ${valueId}` : undefined
    "
    :disabled="edit ? false : view?.calibration.disabled"
    ><template v-if="edit"
      >{{ edit.label
      }}<input
        :key="edit.id"
        v-draft="edit.value"
        type="number"
        class="gev-field gev-field--inline cctv-cal-input"
        :step="edit.step"
        :aria-label="inputLabel || edit.ariaLabel"
        data-owns-escape
        @keydown="onKeydown"
        @blur="onBlur"
        @click.stop /></template
    ><template v-else-if="estimatedLabel">{{
      t('~{n}', { n: view.calibration.numbers[field] })
    }}</template
    ><template v-else-if="bare">{{
      view?.calibration.numbers?.[field] ?? '--'
    }}</template
    ><template v-else>{{
      view?.calibration.values[field] ?? `${t(label)} --`
    }}</template></UiButton
  >
</template>
