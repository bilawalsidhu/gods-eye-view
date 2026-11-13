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
import { t, tn } from '../../../i18n/index.js';
import { useStoriesStore } from '../../stores/stories.js';
import {
  FILTERS,
  clamp,
  fmtDur,
  layersFor,
  metaFor,
  topicsOf,
  storyText,
  windowText,
} from '../../../stories/storyMeta.js';
import StoriesHeader from './StoriesHeader.vue';

/**
 * Explore (prototype `.scr-explore`): the feed beside GEV's Cesium globe,
 * which shows through the map area and takes input where nothing of
 * Stories sits on it.
 */
const emit = defineEmits(['play']);
const store = useStoriesStore();
const { query, chips, sort, filters, picked, pins, feedSnap } =
  storeToRefs(store);

const all = computed(() => store.stories);
// A story's card picture, when there is one; otherwise the card shows its
// placeholder (CSS), never a broken image.
const thumbFor = (s) => (s && store.thumbs?.[s.id]) || '';
const titleOf = (s) => storyText(s.title);
const layerNames = (s) => layersFor(s).map((l) => storyText(l[2]));

// What a story is found by in the feed's search, in the page's language.
function searchText(s) {
  const m = metaFor(s);
  return [
    titleOf(s),
    s.creator,
    windowText(s),
    m.region,
    m.place,
    ...m.topics,
    ...layerNames(s),
  ]
    .join(' ')
    .toLowerCase();
}

const shown = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  const f = filters.value;
  const list = all.value.filter((s) => {
    const m = metaFor(s);
    const txt = searchText(s);
    if (words.some((w) => !txt.includes(w))) return false;
    if (
      chips.value.length &&
      !chips.value.some((c) => (c === 'Live' ? s.live : m.topics.includes(c)))
    )
      return false;
    if (f.region?.length && !f.region.includes(m.region)) return false;
    if (
      f.length?.length &&
      !f.length.includes(s.durationMs < 60000 ? 'short' : 'long')
    )
      return false;
    return true;
  });
  const end = (s) => s.tMaxMs ?? 0;
  const by = {
    new: (a, b) => end(b) - end(a),
    long: (a, b) => b.durationMs - a.durationMs,
    az: (a, b) => titleOf(a).localeCompare(titleOf(b)),
  }[sort.value];
  return [...list].sort(by);
});
const shownIds = computed(() => new Set(shown.value.map((s) => s.id)));
const count = computed(() =>
  shown.value.length === all.value.length
    ? `${all.value.length}`
    : `${shown.value.length}/${all.value.length}`,
);

// ── Chips and filters ──
// Every story is a GEV scene: a "made with" filter would not narrow anything.
// The topic chips and region choices are the ones the stories carry, so
// none of them narrows the feed to nothing.
const topics = computed(() => topicsOf(all.value));
const filterGroups = computed(() =>
  FILTERS.map(([key, label, opts]) => {
    if (key !== 'region') return [key, label, opts];
    const regions = new Set(all.value.map((s) => metaFor(s).region));
    return [key, label, opts.filter(([value]) => regions.has(value))];
  }).filter(([, , opts]) => opts.length > 1),
);
function toggleChip(c) {
  if (!c) chips.value = [];
  else if (chips.value.includes(c))
    chips.value = chips.value.filter((x) => x !== c);
  else chips.value = [...chips.value, c];
}
const filterOpen = ref(false);
const filterCount = computed(() =>
  filterGroups.value.reduce(
    (n, [key]) => n + (filters.value[key]?.length ?? 0),
    0,
  ),
);
function toggleFilter(key, value, on) {
  const list = filters.value[key] ?? [];
  filters.value = {
    ...filters.value,
    [key]: on ? [...list, value] : list.filter((v) => v !== value),
  };
}
function clearFilters() {
  filters.value = { region: [], length: [] };
}
function resetAll() {
  clearFilters();
  chips.value = [];
  query.value = '';
  filterOpen.value = false;
}
const filterEl = ref(null);
const filterBtn = ref(null);
function onDocDown(e) {
  if (
    filterOpen.value &&
    !filterEl.value?.contains(e.target) &&
    !filterBtn.value?.contains(e.target)
  )
    filterOpen.value = false;
}

// ── Search ──
const searchEl = ref(null);
function onSearchKey(e) {
  if (e.key === 'Escape') {
    query.value = '';
    e.target.blur();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    const first = shown.value[0];
    if (first) pick(first.id);
  }
}
function onSlash(e) {
  if (
    e.key === '/' &&
    !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')
  ) {
    e.preventDefault();
    searchEl.value?.focus();
  }
}
function headerSearch() {
  if (feedSnap.value === 'map') setFeed('split');
  searchEl.value?.focus();
}

// ── Picking and playing ──
const feedEl = ref(null);
function pick(id) {
  if (picked.value === id) return;
  if (innerWidth <= 700 && feedSnap.value === 'list') setFeed('split');
  store.controller.pick(id);
  nextTick(() =>
    feedEl.value
      ?.querySelector(`.card[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
}
function play(id, from) {
  emit('play', { id, from });
}
function onCardKey(e, s) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
    e.preventDefault();
    if (picked.value === s.id)
      play(s.id, e.currentTarget.querySelector('.thumb'));
    else pick(s.id);
  }
}
// The pin last clicked: a pin plays on its own second click, so a story
// picked from the feed first shows its play button on the pin.
let armedPin = null;
watch(picked, (id) => {
  if (id !== armedPin) armedPin = null;
});
function onPin(e, id) {
  if (picked.value === id && armedPin === id)
    play(id, e.currentTarget.querySelector('.pin-thumb'));
  else {
    armedPin = id;
    if (picked.value !== id) pick(id);
  }
}
const pickedStory = computed(() =>
  picked.value ? store.byId(picked.value) : null,
);

// ── Pins: projected in window pixels, placed inside the map area ──
const pinsEl = ref(null);
const origin = ref({ x: 0, y: 0 });
function measure() {
  const r = pinsEl.value?.getBoundingClientRect();
  if (r) origin.value = { x: r.left, y: r.top };
}
watch(pins, measure);
const placedPins = computed(() =>
  pins.value.map((p) => ({
    ...p,
    story: store.byId(p.id),
    style: {
      transform: `translate(${p.x - origin.value.x}px, ${p.y - origin.value.y}px) translate(-50%, -100%)`,
    },
  })),
);

// ── Phone: drag the list header to trade globe space for list space ──
const FEED = { map: 0.3, split: 0.56, list: 0.86 };
const FEED_ORDER = ['map', 'split', 'list'];
const bodyEl = ref(null);
const dragging = ref(false);
const feedH = ref(null);
function setFeed(snap) {
  feedSnap.value = snap;
  feedH.value = null;
  setTimeout(() => store.controller.reframe(), 320);
}
let fd = null;
function onHeadDown(e) {
  if (innerWidth > 700 || e.target.closest('.fh-tools')) return;
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* nothing to capture */
  }
  const body = bodyEl.value;
  fd = {
    y: e.clientY,
    frac: body.querySelector('.ex-feed').offsetHeight / body.clientHeight,
    H: body.clientHeight,
    lastY: e.clientY,
    lastT: performance.now(),
    v: 0,
    moved: false,
  };
}
function onHeadMove(e) {
  if (!fd) return;
  const dy = e.clientY - fd.y;
  if (!fd.moved && Math.abs(dy) > 4) {
    fd.moved = true;
    dragging.value = true;
  }
  if (!fd.moved) return;
  feedH.value = clamp(fd.frac - dy / fd.H, 0.18, 0.9);
  const now = performance.now();
  fd.v = (e.clientY - fd.lastY) / Math.max(1, now - fd.lastT);
  fd.lastY = e.clientY;
  fd.lastT = now;
}
function onHeadUp() {
  if (!fd) return;
  if (fd.moved) {
    const f = feedH.value ?? FEED[feedSnap.value];
    let snap;
    if (fd.v < -0.5) snap = f < FEED.split ? 'split' : 'list';
    else if (fd.v > 0.5) snap = f > FEED.split ? 'split' : 'map';
    else
      snap = FEED_ORDER.reduce((a, b) =>
        Math.abs(FEED[b] - f) < Math.abs(FEED[a] - f) ? b : a,
      );
    dragging.value = false;
    setFeed(snap);
  } else setFeed(FEED_ORDER[(FEED_ORDER.indexOf(feedSnap.value) + 1) % 3]);
  fd = null;
}
function onGripKey(e) {
  const i = FEED_ORDER.indexOf(feedSnap.value);
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setFeed(FEED_ORDER[Math.min(2, i + 1)]);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setFeed(FEED_ORDER[Math.max(0, i - 1)]);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setFeed(FEED_ORDER[(i + 1) % 3]);
  }
}
// Desktop and tablet: drag the feed's right edge to widen it, up to 50 px
// past its default; double-click puts it back.
const FEED_W = 340;
const FEED_W_MAX = FEED_W + 50;
const FEED_W_MIN = 280;
const feedW = ref(FEED_W);
try {
  const saved = +localStorage.getItem('gevFeedW');
  if (saved) feedW.value = clamp(saved, FEED_W_MIN, FEED_W_MAX);
} catch {
  /* storage off: the default width */
}
// The feed sits over the map on desktop: a new width moves the free part of
// the map, which a resize of the map itself would not report.
watch(feedW, () => nextTick(() => store.controller.reframe()));
const resizing = ref(false);
let rw = null;
function setFeedW(px) {
  feedW.value = Math.round(clamp(px, FEED_W_MIN, FEED_W_MAX));
  try {
    localStorage.setItem('gevFeedW', feedW.value);
  } catch {
    /* storage off: the width lasts this visit */
  }
}
function onResizeDown(e) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* nothing to capture */
  }
  rw = { x: e.clientX, w: feedW.value };
  resizing.value = true;
  e.preventDefault();
}
function onResizeMove(e) {
  if (rw) setFeedW(rw.w + (e.clientX - rw.x));
}
function onResizeUp() {
  rw = null;
  resizing.value = false;
}
function onResizeKey(e) {
  const d = { ArrowRight: 10, ArrowLeft: -10 }[e.key];
  if (!d) return;
  e.preventDefault();
  setFeedW(feedW.value + d);
}
function onResizeReset() {
  feedW.value = FEED_W;
  try {
    localStorage.removeItem('gevFeedW');
  } catch {
    /* storage off */
  }
}
const bodyStyle = computed(() => ({
  '--feed-h': `${(feedH.value ?? FEED[feedSnap.value]) * 100}%`,
  ...(innerWidth > 700
    ? {
        '--feedw': `${feedW.value}px`,
        gridTemplateColumns: `${feedW.value}px minmax(0, 1fr)`,
      }
    : {}),
}));

onMounted(() => {
  document.addEventListener('pointerdown', onDocDown);
  // On the window: the Stories keyboard guard stops keys before the document.
  addEventListener('keydown', onSlash, true);
  addEventListener('resize', measure);
  measure();
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown);
  removeEventListener('keydown', onSlash, true);
  removeEventListener('resize', measure);
});

defineExpose({
  cardThumb: (id) =>
    feedEl.value?.querySelector(`.card[data-id="${CSS.escape(id)}"]`),
});
</script>

<template>
  <section
    id="scrExplore"
    class="scr scr-explore"
    :aria-label="t('GEV Stories explore')"
  >
    <StoriesHeader
      screen="explore"
      @back="store.controller.close()"
      @home="store.controller.close()"
      @search="headerSearch"
    />
    <div
      id="exBody"
      ref="bodyEl"
      class="ex-body"
      :class="{ 'feed-dragging': dragging }"
      data-side="left"
      :style="bodyStyle"
    >
      <div
        class="ex-feed-resize"
        :class="{ on: resizing }"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('Resize story list')"
        :aria-valuenow="feedW"
        :aria-valuemin="FEED_W_MIN"
        :aria-valuemax="FEED_W_MAX"
        tabindex="0"
        :style="{ left: `${feedW - 5}px` }"
        @pointerdown="onResizeDown"
        @pointermove="onResizeMove"
        @pointerup="onResizeUp"
        @pointercancel="onResizeUp"
        @dblclick="onResizeReset"
        @keydown="onResizeKey"
      ></div>
      <aside class="ex-feed" :aria-label="t('Stories')">
        <div class="ex-feed-top">
          <div
            id="feedHead"
            class="ex-feed-head"
            @pointerdown="onHeadDown"
            @pointermove="onHeadMove"
            @pointerup="onHeadUp"
            @pointercancel="onHeadUp"
          >
            <button
              id="feedGrip"
              class="feed-grip"
              type="button"
              :aria-label="t('Story list size. Drag, or press to change')"
              @keydown="onGripKey"
            ></button>
            <h1>{{ t('GEV Stories') }}</h1>
            <span
              id="exCount"
              :aria-label="
                tn(
                  all.length,
                  '{n} of {count} story',
                  '{n} of {count} stories',
                  {
                    n: shown.length,
                  },
                )
              "
              >{{ count }}</span
            >
            <div class="fh-tools">
              <label class="sr" for="exSort">{{ t('Sort stories') }}</label>
              <select id="exSort" v-model="sort" class="fh-sort">
                <option value="new">{{ t('Newest') }}</option>
                <option value="long">{{ t('Longest') }}</option>
                <option value="az">{{ t('A–Z') }}</option>
              </select>
              <button
                id="exFilterBtn"
                ref="filterBtn"
                type="button"
                class="fh-filter"
                :class="{ on: filterCount }"
                :aria-expanded="filterOpen"
                aria-controls="exFilter"
                :aria-label="
                  filterCount
                    ? tn(filterCount, '{count} filter on', '{count} filters on')
                    : t('Filters')
                "
                @click.stop="filterOpen = !filterOpen"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 6h16M7 12h10M10 18h4" />
                </svg>
                <b v-if="filterCount" id="exFilterN">{{ filterCount }}</b>
              </button>
            </div>
          </div>
          <div id="exTools" class="ex-tools" @pointerdown.stop @wheel.stop>
            <div class="fh-search m-only-search" role="search">
              <label class="sr" for="exQm">{{ t('Search stories') }}</label>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
              <input
                id="exQm"
                ref="searchEl"
                v-model="query"
                class="ex-q"
                type="search"
                :placeholder="t('Search stories, places, creators')"
                autocomplete="off"
                @keydown="onSearchKey"
              />
              <button
                v-if="query"
                type="button"
                class="ex-qx"
                :aria-label="t('Clear search')"
                @click="
                  query = '';
                  searchEl?.focus();
                "
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
              <kbd class="hide-m">/</kbd>
            </div>
            <div class="fh-row">
              <div
                id="exChips"
                class="fh-chips"
                role="group"
                :aria-label="t('Topics')"
              >
                <button
                  type="button"
                  class="chip"
                  :aria-pressed="!chips.length"
                  @click="toggleChip('')"
                  >{{ t('All') }}</button
                >
                <button
                  v-for="c in topics"
                  :key="c"
                  type="button"
                  class="chip"
                  :class="{ live: c === 'Live' }"
                  :aria-pressed="chips.includes(c)"
                  @click="toggleChip(c)"
                  ><i v-if="c === 'Live'"></i>{{ t(c) }}</button
                >
              </div>
            </div>
            <div
              v-if="filterOpen"
              id="exFilter"
              ref="filterEl"
              class="ex-filter"
              role="dialog"
              :aria-label="t('Filter stories')"
            >
              <fieldset v-for="[key, label, opts] in filterGroups" :key="key">
                <legend>{{ t(label) }}</legend>
                <label v-for="[value, text] in opts" :key="value" class="fopt">
                  <input
                    type="checkbox"
                    :checked="filters[key]?.includes(value)"
                    @change="toggleFilter(key, value, $event.target.checked)"
                  />
                  <span>{{ t(text) }}</span>
                </label>
              </fieldset>
              <div class="fact">
                <button type="button" class="tbtn" @click="clearFilters">{{
                  t('Clear')
                }}</button>
                <button
                  type="button"
                  class="tbtn solid"
                  @click="
                    filterOpen = false;
                    filterBtn?.focus();
                  "
                >
                  {{
                    tn(
                      shown.length,
                      'Show {count} story',
                      'Show {count} stories',
                    )
                  }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <ul id="feed" ref="feedEl" class="feed">
          <li v-if="!shown.length" class="feed-empty">
            <b>{{ t('No stories match') }}</b>
            <span>{{ t('Try another word or clear the filters.') }}</span>
            <button type="button" class="tbtn" @click="resetAll">{{
              t('Clear all')
            }}</button>
          </li>
          <li v-for="s in shown" :key="s.id">
            <div
              class="card"
              role="button"
              tabindex="0"
              :data-id="s.id"
              :aria-pressed="picked === s.id"
              @click="pick(s.id)"
              @keydown="onCardKey($event, s)"
            >
              <span class="thumb">
                <img
                  v-if="thumbFor(s)"
                  :src="thumbFor(s)"
                  alt=""
                  loading="lazy"
                />
                <span v-if="s.live" class="chip"
                  ><span class="dot"></span>{{ t('LIVE') }}</span
                >
                <span v-else class="chip">{{
                  s.draft ? t('DRAFT') : t('STORY')
                }}</span>
                <span class="dur">{{ fmtDur(s.durationMs) }}</span>
                <button
                  class="thumb-play"
                  type="button"
                  :aria-label="t('Play {title}', { title: titleOf(s) })"
                  @click.stop="play(s.id, $event.currentTarget.parentElement)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 6.5v11l9-5.5z" fill="currentColor" />
                  </svg>
                </button>
              </span>
              <span class="c-title">{{ titleOf(s) }}</span>
              <span class="c-meta">{{ s.creator }} · {{ windowText(s) }}</span>
              <span class="c-layers"
                ><span v-for="l in layerNames(s)" :key="l">{{ l }}</span></span
              >
              <span class="c-play">
                <button
                  class="tbtn solid"
                  type="button"
                  @click.stop="
                    play(
                      s.id,
                      $event.currentTarget
                        .closest('.card')
                        .querySelector('.thumb'),
                    )
                  "
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 4.5v15l12.5-7.5z" /></svg
                  >{{ t('Play story') }}
                </button>
              </span>
            </div>
          </li>
        </ul>
      </aside>
      <div class="ex-map">
        <div class="map-slot"></div>
        <div id="pins" ref="pinsEl" class="pins">
          <button
            v-for="p in placedPins"
            :key="p.id"
            class="pin"
            :class="{ out: !shownIds.has(p.id), hidden: !p.visible }"
            type="button"
            :data-id="p.id"
            :aria-pressed="picked === p.id"
            :aria-label="t('Preview {title}', { title: titleOf(p.story) })"
            :style="p.style"
            @click="onPin($event, p.id)"
          >
            <span
              class="pin-thumb"
              :data-preview="t('Click to preview')"
              :data-play="t('Click to play')"
              :data-tap="t('Tap to play')"
              :data-play-short="t('Play')"
              ><img v-if="thumbFor(p.story)" :src="thumbFor(p.story)" alt=""
            /></span>
            <span class="pin-lbl">{{ titleOf(p.story).split(':')[0] }}</span>
            <span class="pin-dot"></span>
          </button>
        </div>
        <div class="ex-msearch glass" role="search">
          <label class="sr" for="exQ">{{ t('Search stories') }}</label>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            id="exQ"
            v-model="query"
            class="ex-q"
            type="search"
            :placeholder="t('Search stories, places, creators')"
            autocomplete="off"
            @keydown="onSearchKey"
          />
          <button
            v-if="query"
            type="button"
            class="ex-qx"
            :aria-label="t('Clear search')"
            @click="query = ''"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <kbd>/</kbd>
        </div>
        <div
          v-if="pickedStory"
          id="exPreview"
          class="ex-preview glass"
          aria-live="polite"
        >
          <span class="k"><i></i>{{ t('PREVIEW') }}</span>
          <h2>{{ titleOf(pickedStory) }}</h2>
          <span class="c-meta"
            >{{ pickedStory.creator }} · {{ windowText(pickedStory) }}</span
          >
          <span class="c-layers"
            ><span v-for="l in layerNames(pickedStory)" :key="l">{{
              l
            }}</span></span
          >
          <button
            class="tbtn solid"
            type="button"
            @click="play(pickedStory.id, null)"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 4.5v15l12.5-7.5z" /></svg
            >{{ t('Play story') }}
          </button>
        </div>
        <div v-else class="ex-hint glass">{{
          t('Pick a story or a pin to preview it here')
        }}</div>
      </div>
    </div>
  </section>
</template>
