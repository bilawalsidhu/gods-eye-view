<script setup>
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { useStoriesStore } from '../stores/stories.js';
import { GEV_LOGO_SYMBOL } from '../../stories/gevLogo.js';
import { creditPlacement, entryPlacement } from '../../stories/format.js';
import { guardStoriesKeyboard } from '../../stories/keyboard.js';

// The screens, their styles and the story data load with Stories (see
// src/stories/boot.js); only the button, popup and toast load with GEV.
const ExploreScreen = defineAsyncComponent(
  () => import('./stories/ExploreScreen.vue'),
);
const StoryScreen = defineAsyncComponent(
  () => import('./stories/StoryScreen.vue'),
);

/**
 * GEV Stories, as the Stories prototype lays it out: a Stories button in
 * GEV's top-right row, Explore (the globe beside the story feed) and the
 * Story page. Both show GEV's own Cesium globe through their map areas.
 */
const store = useStoriesStore();
const { mode, storyId, toast, hostedToast } = storeToRefs(store);
const story = computed(() => (storyId.value ? store.byId(storyId.value) : null));
const reduceMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── Entry: in GEV's top-right row, left of what sits in the corner ──
// GEV has its ACTIVE STYLE readout there; GEV Hosted adds the account
// avatar, which can come after Stories mounts (sign-in).
const CORNER = ['style-indicator', 'account-control'];
const entry = ref({ top: 14, right: 14 });
function placeEntry() {
  entry.value = entryPlacement(
    CORNER.map((id) => document.getElementById(id)?.getBoundingClientRect()),
    innerWidth,
  );
}
let entryTries = 0;
let entryTimer = 0;
let cornerObserver = null;
const observed = new Set();
// GEV Hosted moves the corner by body class (signed in, guest) without
// resizing it, which a ResizeObserver does not see.
let bodyObserver = null;
function watchCorner() {
  placeEntry();
  if (!bodyObserver && globalThis.MutationObserver) {
    bodyObserver = new MutationObserver(placeEntry);
    bodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  if (globalThis.ResizeObserver) cornerObserver ??= new ResizeObserver(placeEntry);
  for (const id of CORNER) {
    const el = document.getElementById(id);
    if (el && cornerObserver && !observed.has(el)) {
      cornerObserver.observe(el);
      observed.add(el);
    }
  }
  // Keep looking for a while for a control that mounts late.
  if (observed.size < CORNER.length && ++entryTries < 20)
    entryTimer = setTimeout(watchCorner, 1000);
}

// ── GEV's required credit line: bottom left of the map, at every size ──
// A playing GEV scene turns on GEV's recording mode, whose rule drops the
// credit to the window's bottom edge, under the Stories timeline. Measure
// the map instead and pin the credit just inside it, playing or not.
let creditSlot = null;
let creditObserver = null;
let creditFrame = 0;
let creditTries = 0;
function placeCredit() {
  const root = document.documentElement.style;
  const at = creditPlacement({
    map: creditSlot?.getBoundingClientRect(),
    feed: document.querySelector('#gev-stories .ex-feed')?.getBoundingClientRect(),
    width: innerWidth,
    height: innerHeight,
  });
  if (!at) {
    root.removeProperty('--gs-credit-bottom');
    root.removeProperty('--gs-credit-left');
    return;
  }
  root.setProperty('--gs-credit-bottom', `${at.bottom}px`);
  root.setProperty('--gs-credit-left', `${at.left}px`);
}
function watchCredit() {
  cancelAnimationFrame(creditFrame);
  creditObserver?.disconnect();
  creditSlot = null;
  if (mode.value === 'closed') {
    creditTries = 0;
    placeCredit();
    return;
  }
  creditSlot = document.querySelector('#gev-stories .map-slot');
  if (!creditSlot) {
    if (++creditTries < 120) creditFrame = requestAnimationFrame(watchCredit);
    return;
  }
  creditTries = 0;
  placeCredit();
  if (globalThis.ResizeObserver) {
    creditObserver = new ResizeObserver(placeCredit);
    creditObserver.observe(creditSlot);
    const feed = document.querySelector('#gev-stories .ex-feed');
    if (feed) creditObserver.observe(feed);
  }
}

// ── One onboarding popup in GEV ──
const POP_KEY = 'gevStoriesPopSeen';
const popOpen = ref(false);
function readPopSeen() {
  try {
    return localStorage.getItem(POP_KEY) === '1';
  } catch {
    return store.popSeen;
  }
}
function markPopSeen() {
  store.popSeen = true;
  popOpen.value = false;
  try {
    localStorage.setItem(POP_KEY, '1');
  } catch {
    /* storage off: the popup comes back next visit */
  }
}
function openExplore() {
  markPopSeen();
  store.controller.open();
}

// ── Opened in GEV: a toast that leads back to the story ──
let hostedTimer = 0;
watch(hostedToast, (v) => {
  clearTimeout(hostedTimer);
  if (v) hostedTimer = setTimeout(() => (hostedToast.value = null), 6000);
});
function backToStory() {
  const v = hostedToast.value;
  hostedToast.value = null;
  if (v) store.controller.openStory(v.id, { atMs: v.atMs });
}
const hostedWhen = computed(() => hostedToast.value?.when ?? '');

// ── Card-to-map morph: Play grows the card into the story; Back folds it home ──
const appEl = ref(null);
const rootEl = ref(null);
let unguardKeys = null;
function ghost(id, rect) {
  const g = document.createElement('div');
  g.className = 'morph';
  // Without a picture the ghost keeps the cards' placeholder look (CSS).
  const thumb = store.thumbs?.[id] || '';
  if (thumb) g.style.background = `#04070a url("${thumb}") center / cover no-repeat`;
  Object.assign(g.style, rect);
  appEl.value?.appendChild(g);
  return g;
}
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` };
};
async function playFromExplore({ id, from }) {
  if (reduceMotion() || !from?.offsetWidth) {
    store.controller.openStory(id, { autoplay: true });
    return;
  }
  const a = rectOf(from);
  const g = ghost(id, a);
  store.controller.openStory(id, { autoplay: true });
  await nextTick();
  const map = document.getElementById('stMap');
  if (!map) {
    g.remove();
    return;
  }
  const b = rectOf(map);
  g.animate(
    [
      { ...a, borderRadius: '9px', opacity: 1 },
      { ...b, borderRadius: '0px', opacity: 1, offset: 0.8 },
      { ...b, borderRadius: '0px', opacity: 0 },
    ],
    { duration: 640, easing: 'cubic-bezier(.2,.9,.2,1)' },
  ).onfinish = () => g.remove();
}
async function backFromStory() {
  const id = storyId.value;
  const map = document.getElementById('stMap');
  if (reduceMotion() || !map?.offsetWidth) {
    store.controller.backToExplore();
    return;
  }
  const a = rectOf(map);
  const g = ghost(id, a);
  store.picked = id;
  store.controller.backToExplore();
  await nextTick();
  await new Promise((r) => requestAnimationFrame(r));
  const card = document.querySelector(`#gev-stories .card[data-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: 'nearest' });
  const dst = card?.querySelector('.thumb');
  if (!dst?.offsetWidth) {
    g.remove();
    return;
  }
  g.animate(
    [
      { ...a, borderRadius: '0px', opacity: 1 },
      { ...rectOf(dst), borderRadius: '9px', opacity: 1 },
    ],
    { duration: 560, easing: 'cubic-bezier(.2,.9,.2,1)' },
  ).onfinish = () => {
    g.remove();
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  };
}

// ── Escape closes the topmost open layer, then steps back ──
function onKey(e) {
  if (e.key !== 'Escape' || mode.value === 'closed' || e.defaultPrevented) return;
  const target = e.target;
  if (target?.type === 'search' && target.value) return;
  const q = (sel) => document.querySelector(`#gev-stories ${sel}`);
  e.preventDefault();
  if (q('#exFilter')) q('#exFilterBtn')?.click();
  else if (store.ctxOpen) store.ctxOpen = false;
  else if (store.expanded) {
    store.expanded = false;
    store.controller.reframe();
  } else if (mode.value === 'story') backFromStory();
  else store.controller.close();
}

onMounted(() => {
  watchCorner();
  addEventListener('resize', placeEntry);
  addEventListener('resize', placeCredit);
  addEventListener('keydown', onKey, true);
  unguardKeys = guardStoriesKeyboard({
    root: rootEl.value,
    // Until Close has put the view back, too (stories-mode stays till then).
    isOpen: () =>
      mode.value !== 'closed' ||
      document.body.classList.contains('stories-mode'),
  });
  popOpen.value = !readPopSeen();
  watchCredit();
});
onBeforeUnmount(() => {
  clearTimeout(entryTimer);
  clearTimeout(hostedTimer);
  cancelAnimationFrame(creditFrame);
  cornerObserver?.disconnect();
  bodyObserver?.disconnect();
  creditObserver?.disconnect();
  creditSlot = null;
  placeCredit();
  removeEventListener('resize', placeEntry);
  removeEventListener('resize', placeCredit);
  removeEventListener('keydown', onKey, true);
  unguardKeys?.();
});
watch(mode, (m) => {
  if (m === 'closed') requestAnimationFrame(placeEntry);
  else popOpen.value = false;
});
// Each screen (and each story, keyed) mounts its own map slot.
watch([mode, storyId], () => nextTick(watchCredit));
</script>

<template>
  <div id="gev-stories" ref="rootEl">
    <svg width="0" height="0" style="position: absolute" aria-hidden="true" v-html="GEV_LOGO_SYMBOL"></svg>

    <!-- GEV: the Stories entry, its first-visit popup and the Opened-in-GEV toast -->
    <template v-if="mode === 'closed' && store.available">
      <button
        id="hStories"
        class="tbtn accent gs-entry"
        type="button"
        :style="{ top: `${entry.top}px`, right: `${entry.right}px` }"
        @click="openExplore"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" /></svg>
        <span>{{ t('Stories') }}</span>
      </button>
      <div
        v-if="popOpen"
        id="hPop"
        class="h-pop gs-pop"
        role="region"
        aria-labelledby="hPopT"
        :style="{ top: `${entry.top + 52}px`, right: `${Math.max(12, entry.right - 40)}px` }"
      >
        <span class="k">{{ t('NEW') }}</span>
        <h2 id="hPopT">{{ t('GEV Stories') }}</h2>
        <p>{{ t('Curated, interactive views of what is happening on Earth. Play one, take over the map whenever you like, then pick the story back up.') }}</p>
        <div class="row">
          <button class="tbtn solid" type="button" @click="openExplore">{{ t('Browse stories') }}</button>
          <button class="tbtn" type="button" @click="markPopSeen">{{ t('Not now') }}</button>
        </div>
      </div>
      <div v-if="hostedToast" id="hToast" class="h-toast glass gs-hosted-toast" role="status">
        <b>{{ t('Opened in GEV') }}</b>
        <span>{{ hostedToast.title }} · {{ hostedWhen }}</span>
        <button class="tbtn" type="button" @click="backToStory">{{ t('Back to story') }}</button>
      </div>
    </template>

    <div v-if="mode !== 'closed'" ref="appEl" class="app">
      <ExploreScreen v-if="mode === 'explore'" @play="playFromExplore" />
      <StoryScreen v-if="mode === 'story' && story" :key="story.id" :story="story" @back="backFromStory" />
      <div v-if="toast" id="uxToast" class="ux-toast" role="status" aria-live="polite">{{ toast }}</div>
    </div>
  </div>
</template>
