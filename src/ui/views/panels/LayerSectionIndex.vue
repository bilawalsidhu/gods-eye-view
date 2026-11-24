<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';

// A slim index beside the Data Layers list: one tick per group (Movement,
// Cameras, Infrastructure…). Hovering a tick names its group, clicking it
// scrolls the list there, and the tick for the group in view is lit. It reads
// the list's group headings, which LayerRows renders, so it follows whatever
// groups the layers bring.
const sections = ref([]);
const current = ref(0);
let list = null;
let observer = null;
let resize = null;

function headings() {
  return list ? [...list.querySelectorAll('.data-layer-group-heading:not(.is-filtered)')] : [];
}
function readSections() {
  const next = headings().map((h, i) => ({ i, label: h.textContent.trim() }));
  // Live counts repaint the rows all the time; keep the ticks unless the
  // groups themselves changed.
  const same =
    next.length === sections.value.length &&
    next.every((s, i) => s.label === sections.value[i].label);
  if (!same) sections.value = next;
  syncCurrent();
}
// Only headings matter: a heading added, removed, renamed (a language change)
// or filtered out. Rows' counts and states change many times a second.
const isHeading = (node) =>
  node?.classList?.contains('data-layer-group-heading') ||
  node?.parentElement?.classList?.contains('data-layer-group-heading');
let frame = 0;
function onMutations(mutations) {
  if (frame) return;
  const relevant = mutations.some(
    (m) =>
      (m.type === 'childList' && m.target === list) || isHeading(m.target),
  );
  if (!relevant) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    readSections();
  });
}
function syncCurrent() {
  if (!list) return;
  const top = list.getBoundingClientRect().top + 8;
  let index = 0;
  headings().forEach((h, i) => {
    if (h.getBoundingClientRect().top <= top + 4) index = i;
  });
  // At the very end of the list the last group is the one in view.
  const scrolls = list.clientHeight > 0 && list.scrollHeight > list.clientHeight + 2;
  if (scrolls && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) index = sections.value.length - 1;
  current.value = Math.max(0, index);
}
// The name of the tick being pointed at or focused. It is drawn on the page
// itself, just outside the panel's edge: the panel clips what leaves it, and a
// label inside would cover the rows.
const tip = ref(null);
function showTip(event, section) {
  const box = event.currentTarget.getBoundingClientRect();
  // Beside the tick on whichever side has room: the stack sits on the right
  // in a right-to-left language.
  const before = window.innerWidth - box.right < 180;
  tip.value = {
    label: section.label,
    before,
    left: `${Math.round(before ? box.left - 10 : box.right + 10)}px`,
    top: `${Math.round(box.top + box.height / 2)}px`,
  };
}
const hideTip = () => {
  tip.value = null;
};
function jump(i) {
  const h = headings()[i];
  if (!h || !list) return;
  list.scrollTo({ top: h.offsetTop - list.offsetTop - 4, behavior: 'smooth' });
}

onMounted(() => {
  list = document.getElementById('data-toggles');
  if (!list) return;
  observer = new MutationObserver(onMutations);
  observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  list.addEventListener('scroll', syncCurrent, { passive: true });
  // The list is hidden while the panel is shut; read again when it opens.
  resize = new ResizeObserver(syncCurrent);
  resize.observe(list);
  readSections();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  resize?.disconnect();
  cancelAnimationFrame(frame);
  list?.removeEventListener('scroll', syncCurrent);
});
</script>

<template>
  <nav v-if="sections.length > 1" class="layer-section-index" :aria-label="t('Layer groups')">
    <UiButton
      v-for="section in sections"
      :key="section.i"
      class="layer-section-index__tick"
      :class="{ 'is-current': section.i === current }"
      :aria-label="t('Jump to {name}', { name: section.label })"
      :aria-current="section.i === current ? 'true' : undefined"
      @click="jump(section.i)"
      @mouseenter="showTip($event, section)"
      @mouseleave="hideTip"
      @focus="showTip($event, section)"
      @blur="hideTip"
    ></UiButton>
    <Teleport to="body">
      <span v-if="tip" class="layer-section-index__label"
        :class="{ 'layer-section-index__label--before': tip.before }" :style="{ left: tip.left, top: tip.top }" aria-hidden="true">{{ tip.label }}</span>
    </Teleport>
  </nav>
</template>
