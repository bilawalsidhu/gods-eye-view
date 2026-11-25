<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { t } from '../../../i18n/index.js';
import { useStoriesStore } from '../../stores/stories.js';
import UiButton from '../../kit/UiButton.vue';

/**
 * The Stories top bar (prototype `.h-top.s-head`): back, GEV logo and
 * wordmark, breadcrumb, the phone title (scrolls when it is too long) and
 * the right-hand buttons.
 */
const props = defineProps({
  screen: { type: String, required: true },
  title: { type: String, default: '' },
});
const emit = defineEmits(['back', 'home', 'crumb', 'search']);
const store = useStoriesStore();
// A scene saved on this device only: a link to it opens nothing elsewhere.
const localOnly = computed(
  () =>
    !!store.byId(props.screen === 'story' ? store.storyId : store.picked)?.mine,
);

async function share() {
  const what = props.screen === 'story' ? t('Story') : t('Stories');
  const url = store.controller.shareLink();
  try {
    await navigator.clipboard.writeText(url);
    store.flashToast(t('{what} link copied', { what }));
  } catch {
    store.flashToast(t('Copy this link: {url}', { url }), 4000);
  }
}
// Long titles scroll gently so the whole name can be read.
const mtitle = ref(null);
// Back is a UiButton; its root is the button.
const back = ref(null);
const trail = ref(null);
let observer = null;
function fitTitle() {
  const el = mtitle.value;
  const sp = el?.firstElementChild;
  if (!sp) return;
  const over = sp.scrollWidth - el.clientWidth;
  el.classList.toggle('marquee', over > 4);
  el.style.setProperty('--mq', `${-(over + 22)}px`);
  el.style.setProperty('--mq-dur', `${Math.max(5, (over + 22) / 22)}s`);
}
onMounted(() => {
  const backEl = back.value?.$el;
  const target = backEl?.getClientRects().length
    ? backEl
    : trail.value?.querySelector('button');
  target?.focus({ preventScroll: true });
  if (globalThis.ResizeObserver && mtitle.value) {
    observer = new ResizeObserver(fitTitle);
    observer.observe(mtitle.value);
  }
  fitTitle();
});
watch(
  () => props.title,
  () => nextTick(fitTitle),
);
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <header class="h-top s-head">
    <UiButton
      ref="back"
      class="s-back glass"
      :aria-label="
        screen === 'story' ? t('Back to stories') : t('Back to the globe')
      "
      @click="emit('back')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </UiButton>
    <div class="h-brand">
      <div class="h-brand-row">
        <UiButton
          class="s-home"
          :aria-label="t('Back to the globe')"
          @click="emit('home')"
        >
          <svg class="eye" viewBox="0 0 775 520" aria-hidden="true">
            <use href="#gevLogo" />
          </svg>
        </UiButton>
        <span class="h-word" translate="no">GOD'S EYE <b>VIEW</b></span>
      </div>
      <nav ref="trail" class="h-tag s-trail" :aria-label="t('Breadcrumb')">
        <template v-if="screen === 'explore'">
          <UiButton @click="emit('home')">{{ t('Globe') }}</UiButton>
          <span aria-hidden="true">/</span>
          <b>{{ t('Stories') }}</b>
        </template>
        <template v-else>
          <UiButton @click="emit('crumb')">{{ t('Stories') }}</UiButton>
          <span aria-hidden="true">/</span>
          <b>{{ title }}</b>
        </template>
      </nav>
    </div>
    <span ref="mtitle" class="s-mtitle glass"
      ><span>{{ screen === 'explore' ? t('Stories') : title }}</span></span
    >
    <div class="h-right">
      <UiButton
        v-if="screen === 'explore'"
        class="s-msearch ibtn"
        :aria-label="t('Search')"
        @click="emit('search')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
      </UiButton>
      <UiButton
        v-if="!localOnly"
        class="tbtn hide-m"
        :aria-label="t('Share')"
        @click="share"
      >
        <span class="share-icon" aria-hidden="true">&#x1F517;</span>
        <span>{{ t('Share') }}</span>
      </UiButton>
      <UiButton
        v-if="screen === 'explore'"
        class="tbtn accent hide-m"
        @click="emit('home')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        <span>{{ t('Back to GEV') }}</span>
      </UiButton>
      <UiButton
        v-else
        class="tbtn accent hide-m gs-back-stories"
        @click="emit('crumb')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        <span>{{ t('GEV Stories') }}</span>
      </UiButton>
    </div>
  </header>
</template>
