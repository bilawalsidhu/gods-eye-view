<script setup>
import { storeToRefs } from 'pinia';
import { nextTick, ref } from 'vue';
import { t, tn } from '../../../i18n/index.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { pinTitle } from '../../placeCard.js';
import UiButton from '../../kit/UiButton.vue';

// Unpinning says what went and offers Undo. The notice stays
// while the pointer or focus is on it, and goes a few seconds after.
const pinned = usePinnedStore();
const { unpinned } = storeToRefs(pinned);
// Undo takes the notice away; focus that was on it moves to the pin put
// back (its tile, while Pinned shows), else to the Pinned tab, else to
// Context's body.
const notice = ref(null);
async function undo() {
  const root = notice.value;
  const last = unpinned.value;
  const keys = last?.all ? last.all.map((entry) => entry.pin.key) : [last?.removed?.key];
  const doc = root?.ownerDocument;
  const hadFocus = Boolean(root?.contains(doc?.activeElement));
  const panel = root?.closest('#global-context-panel') || doc;
  pinned.undo();
  if (!hadFocus) return;
  await nextTick();
  const tile = [...panel.querySelectorAll('.pinned-grid__tile')].find((item) => keys.includes(item.dataset.pinKey));
  (tile?.querySelector('.pinned-grid__open') ?? panel.querySelector('#context-tab-pinned') ?? panel.querySelector('[data-rail-scroller]'))?.focus();
}
</script>

<template>
  <p v-if="unpinned" ref="notice" class="context-pin-notice pin-undo-notice" role="status" @mouseenter="pinned.holdNotice('pointer', true)" @mouseleave="pinned.holdNotice('pointer', false)" @focusin="pinned.holdNotice('focus', true)" @focusout="pinned.holdNotice('focus', false)">
    <span>{{ unpinned.all ? tn(unpinned.all.length, 'Unpinned {count} item', 'Unpinned {count} items') : t('Unpinned {name}', { name: pinTitle(unpinned.removed) }) }}</span>
    <UiButton @click="undo">{{ t('Undo') }}</UiButton>
  </p>
</template>
