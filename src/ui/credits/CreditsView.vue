<script setup>
import { t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';
import UiCloseButton from '../kit/UiCloseButton.vue';
import CreditItem from './CreditItem.vue';

// The attribution line at the bottom left and the "Data attribution" list it
// opens, both at the end of `to` (the page's body), where the page's rules
// place them. The owner (src/ui/creditsView.js) computes the credits shown,
// keeps the list's open state and its focus, and takes the clicks and keys;
// `elements` receives the line's, the button's and the list's elements for
// it.
const props = defineProps({
  to: { type: Object, required: true },
  panelId: { type: String, required: true },
  /** The credits on the line, once each. */
  inline: { type: Array, required: true },
  /** The credits in the list, once each. */
  listed: { type: Array, required: true },
  open: { type: Boolean, default: false },
  /**
   * The locale its words are in: a change words them again. The template
   * never reads it; `t()` is not reactive, so a new value is what makes the
   * view render again in the new language.
   */
  locale: { type: String, default: '' },
  elements: { type: Object, required: true },
  onExpand: { type: Function, default: () => {} },
  onClose: { type: Function, default: () => {} },
  onKeydown: { type: Function, default: () => {} },
});

/** Between the line's credits, and before the list's button. */
const SEPARATOR = ' · ';
/** A credit's key: the same text and link are one credit. */
const key = (credit) => `${credit.text}\u0000${credit.href ?? ''}`;
// The list button's words are the slot of a UiButton, which renders inside
// the button: a locale that is not bound to a ref changes nothing the button
// reads, and the owner patches synchronously and reads the result at once. A
// slot given under a condition (`redrawWithView`, always true) is redrawn
// whenever this view is, so the words follow a new locale with the rest.
const redrawWithView = true;
/** Keep `name`'s element for the owner. */
const keep = (name) => (element) => {
  props.elements[name] = element?.$el ?? element;
};
</script>

<template>
  <Teleport :to="props.to"
    ><div id="gev-credits" :ref="keep('bar')" class="gev-credits" tabindex="-1"
      ><span :ref="keep('line')" class="gev-credits-line"
        ><template v-for="(credit, i) in props.inline" :key="key(credit)"
          >{{ i ? SEPARATOR : '' }}<CreditItem :credit="credit" /></template
        >{{ props.inline.length && props.listed.length ? SEPARATOR : '' }}</span
      ><UiButton
        :ref="keep('expand')"
        class="gev-credits-expand"
        aria-haspopup="dialog"
        :aria-controls="props.panelId"
        :aria-expanded="String(props.open)"
        :hidden="props.listed.length === 0"
        @click="props.onExpand()"
        ><template v-if="redrawWithView" #default>{{
          t('Data attribution')
        }}</template></UiButton
      ></div
    ><div
      :id="props.panelId"
      :ref="keep('panel')"
      class="gev-credits-panel"
      role="dialog"
      :aria-labelledby="`${props.panelId}-title`"
      :hidden="!props.open"
      @keydown="props.onKeydown($event)"
      ><div class="gev-credits-header"
        ><span class="gev-credits-title" :id="`${props.panelId}-title`">{{
          t('Data provided by:')
        }}</span
        ><UiCloseButton
          :ref="keep('close')"
          class="gev-credits-close"
          bare
          :label="t('Close data attribution')"
          @click="props.onClose()" /></div
      ><ul class="gev-credits-list"
        ><li v-for="credit in props.listed" :key="key(credit)"
          ><CreditItem :credit="credit" /></li></ul></div
  ></Teleport>
</template>
