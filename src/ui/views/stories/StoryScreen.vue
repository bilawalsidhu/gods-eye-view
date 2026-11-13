<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { storeToRefs } from 'pinia';
import { formatNumber, t } from '../../../i18n/index.js';
import { useStoriesStore } from '../../stores/stories.js';
import { chapterAt } from '../../../stories/format.js';
import {
  chapterTitle,
  clamp,
  clockText,
  layersFor,
  nowFacts,
  storyText,
} from '../../../stories/storyMeta.js';
import StoriesHeader from './StoriesHeader.vue';
import StoryTimeline from './StoryTimeline.vue';
import StoryContext from './StoryContext.vue';
import StoryRail from './StoryRail.vue';

/**
 * One story (prototype `.scr-story`): a GEV scene playing on GEV's Cesium
 * globe, which shows through the map area.
 */
const props = defineProps({ story: { type: Object, required: true } });
const emit = defineEmits(['back']);
const store = useStoriesStore();
const {
  playback,
  expanded,
  ctxOpen,
  sheet,
  contextWidth,
  camera,
  hint,
  bigPlay,
} = storeToRefs(store);

const titleOf = (s) => storyText(s.title);
const title = computed(() => titleOf(props.story));
const k = computed(() => chapterAt(props.story, playback.value.wallMs));
const chapter = computed(() => props.story.chapters[k.value]);
const chTitle = (c) => chapterTitle(props.story, c);
const clock = computed(() =>
  clockText(
    props.story,
    playback.value.wallMs,
    playback.value.worldMs,
    k.value,
  ),
);
const layers = computed(() => layersFor(props.story));
const facts = computed(() =>
  nowFacts(props.story, playback.value.worldMs, playback.value.wallMs),
);
const posText = computed(() => {
  const { lat, lon, altKm } = camera.value;
  return {
    pos: `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`,
    // ALT and KM are HUD codes, as in GEV's own readout; the number follows
    // the page's language.
    alt: ` · ALT ${formatNumber(altKm)} KM`,
  };
});
const legendStyle = (l) =>
  l[0] === 'dash'
    ? { borderTop: `2px dashed ${l[1]}` }
    : l[0] === 'line'
      ? { borderTopColor: l[1] }
      : { background: l[1] };
const legendClass = (l) => (l[0] === 'dot' ? 'dot' : l[0] === 'sq' ? 'sq' : '');

// ── Navigation within the story ──
const timelineRef = ref(null);
function goChapter(i) {
  store.controller.seek(props.story.chapters[i].wallMs + 1);
  if (playback.value.exploring) store.controller.resume();
}
function goAnchor(ev) {
  store.controller.focusEvent(ev);
  if (innerWidth <= 700) sheet.value = 'half';
}
function bigPlayClick() {
  bigPlay.value = false;
  if (playback.value.exploring) store.controller.resume();
  else store.controller.play();
}

// ── Story card: Chapter · On the map · Right now ──
const page = ref(0);
const cardMin = ref(false);
const cardDragging = ref(false);
const trackEl = ref(null);
const cardEl = ref(null);
const pgEls = ref([]);
const trackHeight = ref(null);
const dragOffset = ref(null);
function sizeCard() {
  const pg = pgEls.value[page.value];
  if (pg) trackHeight.value = pg.offsetHeight;
}
function setPage(p) {
  page.value = clamp(p, 0, 2);
  dragOffset.value = null;
  requestAnimationFrame(sizeCard);
}
const trackStyle = computed(() => ({
  transform:
    dragOffset.value != null
      ? `translateX(${dragOffset.value}px)`
      : `translateX(${-page.value * 100}%)`,
  height: trackHeight.value ? `${trackHeight.value}px` : null,
}));
let pd = null;
function onCardDown(e) {
  if (e.target.closest('#pgDots, .pg-min, .pg-mini') || cardMin.value) return;
  e.stopPropagation();
  pd = {
    x: e.clientX,
    y: e.clientY,
    w: cardEl.value.offsetWidth,
    t: performance.now(),
    moved: false,
  };
  try {
    cardEl.value.setPointerCapture(e.pointerId);
  } catch {
    /* nothing to capture */
  }
}
function onCardMove(e) {
  if (!pd) return;
  const dx = e.clientX - pd.x;
  if (
    !pd.moved &&
    Math.abs(dx) > 6 &&
    Math.abs(dx) > Math.abs(e.clientY - pd.y)
  ) {
    pd.moved = true;
    cardDragging.value = true;
  }
  if (!pd.moved) return;
  // Rubber band at the ends.
  const ends = (page.value === 0 && dx > 0) || (page.value === 2 && dx < 0);
  dragOffset.value = -page.value * pd.w + (ends ? dx * 0.3 : dx);
}
function onCardUp(e) {
  if (!pd) return;
  if (pd.moved) {
    const dx = e.clientX - pd.x;
    const fast = Math.abs(dx) / Math.max(1, performance.now() - pd.t) > 0.4;
    cardDragging.value = false;
    setPage(
      page.value + (Math.abs(dx) > pd.w * 0.25 || fast ? (dx < 0 ? 1 : -1) : 0),
    );
  }
  pd = null;
}
function onCardKey(e) {
  if (e.key === 'ArrowRight') setPage(page.value + 1);
  else if (e.key === 'ArrowLeft') setPage(page.value - 1);
}
const minBtn = ref(null);
const miniBtn = ref(null);
function setCardMin(on) {
  cardMin.value = on;
  if (!on) requestAnimationFrame(sizeCard);
}
// The card shows for a few seconds at each chapter (new info), then folds
// to its pill so the map has room (prototype, on every screen size here).
let cardTimer = 0;
function cardPeek() {
  clearTimeout(cardTimer);
  setCardMin(false);
  cardTimer = setTimeout(() => {
    if (!cardHover) setCardMin(true);
  }, 5000);
}
// The card stays open while the pointer is on it, then folds a moment later.
let cardHover = false;
function onCardEnter() {
  cardHover = true;
  clearTimeout(cardTimer);
}
function onCardLeave() {
  cardHover = false;
  if (!cardMin.value) cardTimer = setTimeout(() => setCardMin(true), 2500);
}
watch(k, () => cardPeek());
let cardObserver = null;

// ── Phone: controls fade in expanded full screen while playing ──
const controlsHidden = ref(false);
let pokeTimer = 0;
function pokeControls() {
  controlsHidden.value = false;
  clearTimeout(pokeTimer);
  if (
    expanded.value &&
    playback.value.playing &&
    !playback.value.exploring &&
    innerWidth <= 700
  )
    pokeTimer = setTimeout(() => (controlsHidden.value = true), 3000);
}
watch([expanded, () => playback.value.playing], pokeControls);
function onSectionMove(e) {
  if (e.pointerType !== 'mouse' || controlsHidden.value) pokeControls();
}

// ── Phone: the first play shows that the context can be pulled up ──
const sheetHint = ref(false);
const nudge = ref(false);
let hintTimers = [];
watch(
  () => playback.value.playing,
  (on) => {
    if (!on || store.sheetHintSeen) return;
    hintTimers.push(
      setTimeout(() => {
        if (store.sheetHintSeen || innerWidth > 700 || sheet.value !== 'peek')
          return;
        store.sheetHintSeen = true;
        sheetHint.value = true;
        nudge.value = true;
        hintTimers.push(setTimeout(() => (nudge.value = false), 2400));
        hintTimers.push(setTimeout(() => (sheetHint.value = false), 5200));
      }, 1500),
    );
  },
);
watch(sheet, () => (sheetHint.value = false));

// ── Desktop: drag the context panel's left edge to resize ──
const resizing = ref(false);
const limits = () => [260, Math.max(280, Math.min(640, innerWidth - 420))];
function setCtxW(px) {
  const [a, b] = limits();
  contextWidth.value = Math.round(clamp(px, a, b));
  try {
    localStorage.setItem('gevCtxW', contextWidth.value);
  } catch {
    /* storage off: the width lasts this visit */
  }
}
let rd = null;
function onResizeDown(e) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* nothing to capture */
  }
  rd = {
    x: e.clientX,
    w: document.getElementById('stCtx')?.offsetWidth ?? 340,
  };
  resizing.value = true;
  e.preventDefault();
}
function onResizeMove(e) {
  if (rd) setCtxW(rd.w + (rd.x - e.clientX));
}
function onResizeUp() {
  if (!rd) return;
  rd = null;
  resizing.value = false;
  store.controller.reframe();
}
function onResizeReset() {
  contextWidth.value = 0;
  try {
    localStorage.removeItem('gevCtxW');
  } catch {
    /* storage off */
  }
  store.controller.reframe();
}
function onResizeKey(e) {
  const d = { ArrowLeft: 24, ArrowRight: -24 }[e.key];
  if (!d) return;
  e.preventDefault();
  setCtxW((document.getElementById('stCtx')?.offsetWidth ?? 340) + d);
  store.controller.reframe();
}

const sectionStyle = computed(() =>
  contextWidth.value && !expanded.value
    ? { '--ctxw': `${contextWidth.value}px` }
    : null,
);

onMounted(() => {
  try {
    const v = +localStorage.getItem('gevCtxW');
    if (v) contextWidth.value = v;
  } catch {
    /* storage off */
  }
  if (globalThis.ResizeObserver && cardEl.value) {
    cardObserver = new ResizeObserver(sizeCard);
    cardObserver.observe(cardEl.value);
  }
  nextTick(sizeCard);
  cardPeek();
});
onBeforeUnmount(() => {
  clearTimeout(cardTimer);
  clearTimeout(pokeTimer);
  hintTimers.forEach(clearTimeout);
  cardObserver?.disconnect();
});
watch(
  () => props.story.id,
  () => {
    page.value = 0;
    cardMin.value = false;
    nextTick(sizeCard);
  },
);
watch([k, page], () => nextTick(sizeCard));
</script>

<template>
  <section
    id="scrStory"
    class="scr scr-story"
    :class="{
      exploring: playback.exploring,
      expanded,
      'ctx-open': ctxOpen,
      'ctx-sized': !!contextWidth,
      'controls-hidden': controlsHidden,
      'sheet-hinting': sheetHint,
      'ctx-resizing': resizing,
    }"
    :aria-label="t('GEV Story')"
    :data-sheet="sheet"
    data-chapters="timeline"
    :style="sectionStyle"
    @pointerdown="pokeControls"
    @pointermove="onSectionMove"
    @keydown="pokeControls"
  >
    <StoriesHeader
      screen="story"
      :title="title"
      @back="emit('back')"
      @crumb="emit('back')"
      @home="store.controller.close()"
    />
    <div class="st-body">
      <aside class="st-chapters" :aria-label="t('Chapters')">
        <div class="ch-credit">
          <span class="label"
            ><span class="chip">{{
              story.live ? t('LIVE') : story.draft ? t('DRAFT') : t('STORY')
            }}</span></span
          >
          <div class="t">{{ title }}</div>
          <div class="c-meta">{{
            t('by {creator}', { creator: story.creator })
          }}</div>
        </div>
        <ol class="ch-list">
          <li v-for="(c, i) in story.chapters" :key="c.id">
            <button
              class="ch-item"
              :class="{ done: i < k }"
              type="button"
              :aria-current="i === k ? 'step' : undefined"
              @click="goChapter(i)"
            >
              <span class="n">{{ i + 1 }}</span
              ><span
                ><b>{{ chTitle(c) }}</b></span
              >
            </button>
          </li>
        </ol>
      </aside>
      <div class="st-main">
        <div id="stMap" class="st-map">
          <div class="map-slot"></div>

          <div
            id="ovChapter"
            ref="cardEl"
            class="ov ov-chapter glass"
            :class="{ min: cardMin, dragging: cardDragging }"
            role="region"
            aria-roledescription="carousel"
            :aria-label="t('Story card')"
            tabindex="0"
            @pointerdown="onCardDown"
            @pointermove="onCardMove"
            @pointerup="onCardUp"
            @pointercancel="onCardUp"
            @keydown="onCardKey"
            @focusin="!cardMin && cardPeek()"
            @mouseenter="onCardEnter"
            @mouseleave="onCardLeave"
          >
            <div
              id="pgTrack"
              ref="trackEl"
              class="pg-track"
              :style="trackStyle"
            >
              <section
                :ref="(el) => (pgEls[0] = el)"
                class="pg"
                aria-roledescription="slide"
                :aria-label="t('Chapter')"
                :aria-hidden="page !== 0"
                aria-live="polite"
              >
                <div class="k">{{
                  t('CHAPTER {n} / {total}', {
                    n: k + 1,
                    total: story.chapters.length,
                  })
                }}</div>
                <div class="t">{{ chTitle(chapter) }}</div>
                <div v-if="chapter.caption" class="c">{{
                  storyText(chapter.caption)
                }}</div>
              </section>
              <section
                :ref="(el) => (pgEls[1] = el)"
                class="pg"
                aria-roledescription="slide"
                :aria-label="t('On the map')"
                :aria-hidden="page !== 1"
              >
                <div class="k">{{ t('ON THE MAP') }}</div>
                <div class="pg-legend">
                  <span v-for="l in layers" :key="l[2]"
                    ><i :class="legendClass(l)" :style="legendStyle(l)"></i
                    >{{ storyText(l[2]) }}</span
                  >
                </div>
              </section>
              <section
                :ref="(el) => (pgEls[2] = el)"
                class="pg"
                aria-roledescription="slide"
                :aria-label="t('Right now')"
                :aria-hidden="page !== 2"
              >
                <div class="k">{{ t('RIGHT NOW') }} · {{ clock.big }}</div>
                <div class="pg-facts">
                  <div v-for="f in facts" :key="f[1]"
                    ><b :class="{ warn: f[2] }">{{ f[0] }}</b
                    ><span>{{ t(f[1]) }}</span></div
                  >
                </div>
              </section>
            </div>
            <button
              id="pgMin"
              ref="minBtn"
              class="pg-min"
              type="button"
              :aria-label="t('Minimise card')"
              :aria-expanded="!cardMin"
              @click.stop="
                setCardMin(true);
                nextTick(() => miniBtn?.focus());
              "
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M6 15l6-6 6 6" />
              </svg>
            </button>
            <button
              id="pgMini"
              ref="miniBtn"
              class="pg-mini"
              type="button"
              :aria-label="t('Expand card')"
              @click.stop="
                setCardMin(false);
                cardPeek();
                nextTick(() => minBtn?.focus());
              "
            >
              <b>{{ k + 1 }}/{{ story.chapters.length }}</b
              ><span>{{ chTitle(chapter) }}</span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div
              id="pgDots"
              class="pg-dots"
              role="group"
              :aria-label="t('Card pages')"
            >
              <button
                v-for="(lbl, i) in [
                  t('Chapter'),
                  t('On the map'),
                  t('Right now'),
                ]"
                :key="i"
                type="button"
                :aria-label="lbl"
                :aria-current="String(i === page)"
                @click="setPage(i)"
              ></button>
            </div>
          </div>

          <div id="ovClock" class="ov ov-clock">
            <b>{{ clock.big }}</b
            ><span>{{ t(clock.small) }}</span>
            <span class="pos"
              >{{ posText.pos }}<i>{{ posText.alt }}</i></span
            >
          </div>
          <div id="ovLegend" class="ov ov-legend">
            <span v-for="l in layers" :key="l[2]" class="glass"
              ><i :class="legendClass(l)" :style="legendStyle(l)"></i
              >{{ storyText(l[2]) }}</span
            >
          </div>
          <div
            v-if="bigPlay && !playback.playing"
            id="ovPlay"
            class="ov ov-play"
          >
            <button
              id="btnBigPlay"
              type="button"
              :aria-label="t('Play story')"
              @click="bigPlayClick"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M8 5.7v12.6c0 .9 1 1.4 1.7.9l9.7-6.3a1.1 1.1 0 0 0 0-1.8L9.7 4.8C9 4.3 8 4.8 8 5.7Z"
                />
              </svg>
            </button>
          </div>
          <button
            id="btnCtx"
            class="ov ov-ctxbtn tbtn"
            type="button"
            :aria-pressed="ctxOpen"
            @click="ctxOpen = !ctxOpen"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <rect x="4" y="4" width="16" height="16" rx="3" />
              <path d="M14 4v16" />
            </svg>
            <span>{{ t('Context') }}</span>
          </button>
          <div v-if="hint" id="ovHint" class="ov ov-hint glass">{{ hint }}</div>
          <StoryRail />
        </div>
        <StoryTimeline ref="timelineRef" :story="story" @anchor="goAnchor" />
      </div>
      <div
        id="ctxResize"
        class="ctx-resize"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('Resize context panel')"
        :aria-valuenow="contextWidth || undefined"
        tabindex="0"
        @pointerdown="onResizeDown"
        @pointermove="onResizeMove"
        @pointerup="onResizeUp"
        @pointercancel="onResizeUp"
        @dblclick="onResizeReset"
        @keydown="onResizeKey"
      ></div>
      <StoryContext
        :story="story"
        :nudge="nudge"
        @chapter="goChapter"
        @anchor="goAnchor"
        @open="(id) => store.controller.openStory(id, { autoplay: true })"
        @hide="ctxOpen = false"
      />
      <div
        v-if="sheetHint"
        id="sheetHint"
        class="sheet-hint"
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
        {{ t('Swipe up for context') }}
      </div>
    </div>
  </section>
</template>
