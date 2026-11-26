<script setup>
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';

// The Omnibar's guided walk: the spotlight ring and the callout beside it,
// teleported to the end of `to` (the page's body). `startGuide()` in
// src/ui/omnibarGuide.js owns every decision and every word: it renders this
// with the `view` it computes for each step and keeps the parts the template
// never binds: the guide's `visible` class, the callout's entrance replay
// (its `swap` class), place and side, the ring's and the extra rings' boxes,
// and focus. It finds those elements in the rendered tree itself. The extra
// rings, one per further target of a step, follow the callout; `view.subRings`
// says how many are drawn.
defineProps({
  to: { type: Object, required: true },
  view: { type: Object, required: true },
  onClose: { type: Function, required: true },
  onSkip: { type: Function, required: true },
  onOffer: { type: Function, required: true },
  onNext: { type: Function, required: true },
});

/** A progress segment's attributes: no class at all for one still to come. */
const dot = (name) => (name ? { class: name } : {});
// The buttons' words are the slot of a UiButton, which renders inside the
// button: a step that changes only a label would reach it a tick after the
// owner paints. A slot given under a condition (`redrawWithView`, always
// true) is redrawn whenever this view is, so it keeps up.
const redrawWithView = true;
</script>

<!-- Only line breaks inside tags: the markup has no whitespace between elements. -->
<template><Teleport :to="to"
    ><div class="gev-guide"
      ><div class="gev-guide-ring"><i></i></div
      ><div
        class="gev-guide-callout"
        role="dialog"
        aria-modal="false"
        tabindex="-1"
        aria-labelledby="gev-guide-title"
        aria-describedby="gev-guide-text"
        ><div class="gev-guide-head"
          ><p id="gev-guide-title" class="gev-guide-title">{{ view.title }}</p
          ><p class="gev-guide-count">{{ view.count }}</p
          ><UiCloseButton
            class="gev-guide-close"
            :label="view.endLabel"
            :title="view.endLabel"
            @click="onClose()" /></div
        ><ol class="gev-guide-progress" aria-hidden="true"
          ><li
            v-for="(name, i) in view.progress"
            :key="`${view.step}-${i}`"
            v-bind="dot(name)"></li></ol
        ><div class="gev-guide-body"
          ><p id="gev-guide-text" class="gev-guide-text">{{ view.text }}</p
          ><p class="gev-guide-hint" :hidden="view.hintHidden"
            ><span class="gev-guide-hint-dot"></span
            ><span>{{ view.hint }}</span></p
          ></div
        ><div class="gev-guide-actions"
          ><p class="gev-guide-keys" :hidden="view.keysHidden"
            ><kbd>{{ view.keyCap }}</kbd><span>{{ view.keyText }}</span></p
          ><span
            ><UiButton
              class="gev-guide-skip"
              :hidden="view.skipHidden"
              @click="onSkip()"
              ><template v-if="redrawWithView" #default>{{ view.skipLabel }}</template></UiButton
            ><UiButton
              class="gev-guide-offer"
              :hidden="view.offerHidden"
              @click="onOffer()"
              ><template v-if="redrawWithView" #default>{{ view.offerLabel }}</template></UiButton
            ><UiButton
              class="gev-guide-next"
              :class="{ quiet: view.nextQuiet }"
              :hidden="view.nextHidden"
              @click="onNext()"
              ><template v-if="redrawWithView" #default>{{ view.nextLabel }}</template></UiButton
            ></span
          ></div
        ><p class="gev-guide-status" role="status" aria-live="polite">{{
          view.status
        }}</p></div
      ><div
        v-for="i in view.subRings"
        :key="i"
        class="gev-guide-ring gev-guide-ring--sub"></div
      ></div
    ></Teleport
></template>
