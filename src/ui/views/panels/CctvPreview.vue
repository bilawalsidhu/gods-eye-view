<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useCctvStore } from '../../stores/cctv.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// A selected camera's card: a thumbnail of its latest frame, a few facts,
// and a button that opens the full CCTV panel. The frame and facts come from
// the CCTV panel's own store, which follows the camera picked on the map.
const props = defineProps({
  /** The camera's id (the card identity's id). */
  cameraId: { type: String, default: '' },
});

const cctv = useCctvStore();
const { view, frame, sourceBadge } = storeToRefs(cctv);
const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);

const same = computed(() => !props.cameraId || frame.value?.cameraId === props.cameraId);
const src = computed(() => (same.value ? frame.value?.src || frame.value?.currentSrc || '' : ''));
const params = computed(() => {
  try {
    return new URL(src.value, location.origin).searchParams;
  } catch {
    return new URLSearchParams();
  }
});
const name = computed(() => params.value.get('label') || '');
// The panel's meta line, e.g. "US-290 · HDG 248° · FOV 44° · RANGE 145m · … · TxDOT · …".
const facts = computed(() => {
  // The panel's line belongs to the camera it shows, which may be another.
  if (!same.value) return [];
  const parts = String(view.value?.meta || '')
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean);
  const pick = (re) => parts.find((p) => re.test(p))?.replace(/^(HDG|FOV|RANGE)\s*/, '') || '';
  return [
    { label: t('Heading'), value: pick(/^HDG/) },
    { label: t('Field of view'), value: pick(/^FOV/) },
    { label: t('Range'), value: pick(/^RANGE/) },
    { label: t('Operator'), value: parts.find((p) => /DOT|Transportation|Works|City|County/i.test(p)) || '' },
  ].filter((f) => f.value);
});

// The bigger view: a popup over the map with the same frame, closed by its
// ×, Esc or a click outside.
const big = ref(false);
const onKey = (e) => {
  if (e.key === 'Escape') big.value = false;
};
// The cleanup also runs when the card unmounts, even if `big` turned false in
// the same tick and the watcher never saw it.
watch(big, (open, _, onCleanup) => {
  if (!open) return;
  cctv.showPreviewPopup(true);
  document.addEventListener('keydown', onKey);
  onCleanup(() => {
    cctv.showPreviewPopup(false);
    document.removeEventListener('keydown', onKey);
  });
});
onMounted(() => cctv.showPreviewCard(true));
onBeforeUnmount(() => cctv.showPreviewCard(false));

function openPanel() {
  if (panels.value['cctv-panel']?.collapsed !== false) chrome.act('toggle', 'cctv-panel');
}
</script>

<template>
  <section class="cctv-preview">
    <div class="cctv-preview__frame" :class="{ 'is-empty': !src }">
      <img v-if="src" :src="src" :alt="name || t('Camera frame')" />
      <span v-else>{{ t('Acquiring frame…') }}</span>
      <span v-if="sourceBadge?.label" class="cctv-preview__badge">{{ sourceBadge.label }}</span>
      <UiButton v-if="src" class="cctv-preview__expand" :label="t('Show a bigger view')" @click="big = true">
        <UiIcon name="open_in_full" :size="null" />
      </UiButton>
    </div>
    <Teleport to="body">
      <div v-if="big" class="cctv-popup" role="dialog" :aria-label="name || t('Camera view')" @click.self="big = false">
        <figure class="cctv-popup__card">
          <header class="cctv-popup__head">
            <UiIcon name="videocam" :size="null" />
            <strong>{{ name || t('Camera view') }}</strong>
            <span v-if="sourceBadge?.label" class="cctv-popup__badge">{{ sourceBadge.label }}</span>
            <UiCloseButton class="cctv-popup__close" glyph="icon" :label="t('Close')" @click="big = false" />
          </header>
          <img :src="src" :alt="name || t('Camera frame')" />
          <figcaption v-if="facts.length">
            <span v-for="fact in facts" :key="fact.label">{{ fact.label }} <b>{{ fact.value }}</b></span>
          </figcaption>
        </figure>
      </div>
    </Teleport>
    <dl v-if="facts.length" class="cctv-preview__facts">
      <div v-for="fact in facts" :key="fact.label">
        <dt>{{ fact.label }}</dt>
        <dd>{{ fact.value }}</dd>
      </div>
    </dl>
    <UiButton class="entity-card__action cctv-preview__more" @click="openPanel">
      <UiIcon name="videocam" :size="null" />{{ t('More info') }}
    </UiButton>
  </section>
</template>
