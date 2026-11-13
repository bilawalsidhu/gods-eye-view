<script setup>
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { t, tn } from '../../../i18n/index.js';
import { useStoriesStore } from '../../stores/stories.js';
import { chapterAt } from '../../../stories/format.js';
import {
  anchorStamp,
  chapterStamp,
  chapterTitle,
  clamp,
  nowFacts,
  storyText,
  windowText,
} from '../../../stories/storyMeta.js';

/**
 * The context panel (prototype `.st-ctx`): docked on the right on desktop,
 * a sheet that peeks above the timeline on a phone. It shows what a GEV
 * scene carries: right-now facts, chapters, key moments, sources and
 * background, with a search over its chapters, key moments and sources.
 */
const props = defineProps({
  story: { type: Object, required: true },
  nudge: Boolean,
});
const emit = defineEmits(['chapter', 'anchor', 'open', 'hide']);
const store = useStoriesStore();
const { playback, sheet } = storeToRefs(store);

const k = computed(() => chapterAt(props.story, playback.value.wallMs));
const chTitle = (c) => chapterTitle(props.story, c);
const events = computed(() => props.story.events ?? []);
// The background in the page's language: one text, or parts (a shipped
// scene's layers) translated one by one.
const background = computed(() =>
  []
    .concat(props.story.background || [])
    .map((part) => storyText(part))
    .join(' '),
);
const stamp = (ms, world) => anchorStamp(props.story, ms, world);
const facts = computed(() =>
  nowFacts(props.story, playback.value.worldMs, playback.value.wallMs),
);
const peekFacts = computed(() => facts.value.slice(0, 3));
const sheetSum = computed(
  () =>
    `${k.value + 1}/${props.story.chapters.length} · ${chTitle(props.story.chapters[k.value])} · ${tn(props.story.sources.length, '{count} source', '{count} sources')}`,
);
const titleOf = (s) => storyText(s.title);
const related = computed(() =>
  store.stories.filter((x) => x.id !== props.story.id).slice(0, 3),
);
// A related story's card picture, when there is one (CSS draws a placeholder).
const thumbOf = (s) => store.thumbs?.[s.id] || '';

// ── Search this story: its chapters, key moments and sources ──
const GLYPH = { ch: '#', ev: '•', src: '↗' };
const query = ref('');
const active = ref(-1);
const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return null;
  const hit = (x) => `${x.title} ${x.sub}`.toLowerCase().includes(q);
  const chs = props.story.chapters
    .map((c, i) => ({
      type: 'ch',
      k: i,
      title: chTitle(c),
      sub: `${t('Chapter {n}', { n: i + 1 })} · ${chapterStamp(props.story, c)}`,
    }))
    .filter(hit);
  const evs = events.value
    .map((ev, i) => ({
      type: 'ev',
      k: i,
      ev,
      title: storyText(ev.label),
      sub: `${t('Key moments')} · ${stamp(ev.wallMs, ev.tMs)}`,
    }))
    .filter(hit);
  const srcs = props.story.sources
    .map((x) => ({
      type: 'src',
      href: x[2],
      title: storyText(x[0]),
      sub: storyText(x[1]),
    }))
    .filter(hit);
  return [...chs, ...evs, ...srcs].slice(0, 9);
});
function onQuery() {
  active.value = results.value?.length ? 0 : -1;
}
function choose(x) {
  if (!x) return;
  query.value = '';
  if (x.type === 'ch') emit('chapter', x.k);
  else if (x.type === 'ev') emit('anchor', x.ev);
  else if (x.type === 'src' && x.href && x.href !== '#')
    window.open(x.href, '_blank', 'noopener');
}
function onSearchKey(e) {
  const list = results.value ?? [];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!list.length) return;
    active.value =
      (active.value + (e.key === 'ArrowDown' ? 1 : -1) + list.length) %
      list.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(list[active.value]);
  } else if (e.key === 'Escape') query.value = '';
}

// ── Phone sheet: follows the finger, snaps to peek / half / full ──
const SNAPS = ['peek', 'half', 'full'];
const el = ref(null);
const dragH = ref(null);
const dragging = ref(false);
let sd = null;
function heights() {
  const H = el.value?.closest('.st-body')?.clientHeight || innerHeight;
  return { peek: 100, half: H * 0.54, full: H * 0.88, H };
}
function setSheet(s) {
  sheet.value = s;
  dragH.value = null;
  setTimeout(() => store.controller.reframe(), 320);
}
function onHandleDown(e) {
  if (innerWidth > 700) return;
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* nothing to capture */
  }
  sd = {
    y: e.clientY,
    h: el.value.offsetHeight,
    lastY: e.clientY,
    lastT: performance.now(),
    v: 0,
    moved: false,
  };
}
function onHandleMove(e) {
  if (!sd) return;
  const dy = e.clientY - sd.y;
  if (!sd.moved && Math.abs(dy) > 4) {
    sd.moved = true;
    dragging.value = true;
  }
  if (!sd.moved) return;
  dragH.value = clamp(sd.h - dy, 100, heights().H * 0.92);
  const now = performance.now();
  sd.v = (e.clientY - sd.lastY) / Math.max(1, now - sd.lastT);
  sd.lastY = e.clientY;
  sd.lastT = now;
}
let justDragged = false;
function onHandleUp() {
  if (!sd) return;
  if (sd.moved) {
    const hs = heights();
    const h = dragH.value ?? hs[sheet.value];
    let target;
    if (sd.v < -0.5) target = h < hs.half ? 'half' : 'full';
    else if (sd.v > 0.5) target = h > hs.half ? 'half' : 'peek';
    else
      target = SNAPS.reduce((a, b) =>
        Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a,
      );
    dragging.value = false;
    justDragged = true;
    setSheet(target);
  }
  sd = null;
}
function onHandleClick() {
  if (justDragged) {
    justDragged = false;
    return;
  }
  setSheet(SNAPS[(SNAPS.indexOf(sheet.value) + 1) % 3]);
}
function onHandleKey(e) {
  const i = SNAPS.indexOf(sheet.value);
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSheet(SNAPS[Math.min(2, i + 1)]);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSheet(SNAPS[Math.max(0, i - 1)]);
  }
}
defineExpose({ dragging });
</script>

<template>
  <aside
    id="stCtx"
    ref="el"
    class="st-ctx"
    :class="{ nudge }"
    :aria-label="t('Context')"
    :style="dragH != null ? { height: `${dragH}px` } : null"
  >
    <button
      id="sheetHandle"
      class="sheet-handle"
      type="button"
      :aria-expanded="sheet !== 'peek'"
      :aria-label="
        sheet === 'peek'
          ? t('Context. Swipe up or press to open')
          : t('Context. Swipe down or press to close')
      "
      @pointerdown="onHandleDown"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleUp"
      @click="onHandleClick"
      @keydown="onHandleKey"
    >
      <span class="pk-top">
        <span class="lbl">{{ t('Context') }}</span>
        <span id="sheetSum" class="sum">{{ sheetSum }}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 15l6-6 6 6" />
        </svg>
      </span>
      <span id="peekFacts" class="pk-facts" aria-hidden="true">
        <span v-for="f in peekFacts" :key="f[1]"
          ><b :class="{ warn: f[2] }">{{ f[0] }}</b
          >{{ t(f[1]) }}</span
        >
      </span>
    </button>
    <div class="cx-search-wrap">
      <div class="cx-search">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
        <input
          id="cxQ"
          v-model="query"
          type="search"
          :placeholder="t('Search this story')"
          autocomplete="off"
          spellcheck="false"
          :aria-label="t('Search this story')"
          role="combobox"
          :aria-expanded="!!results"
          aria-controls="cxResults"
          @input="onQuery"
          @keydown="onSearchKey"
        />
        <button
          class="cx-ic"
          type="button"
          disabled
          :aria-label="t('Voice search (not in this build)')"
          :title="t('Voice search (not in this build)')"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </svg>
        </button>
      </div>
      <ul
        v-if="results"
        id="cxResults"
        class="cx-results"
        role="listbox"
        :aria-label="t('Search results')"
      >
        <li v-for="(x, i) in results" :key="`${x.type}:${x.k ?? x.title}`">
          <button
            type="button"
            role="option"
            :aria-selected="i === active"
            @click="choose(x)"
          >
            <span class="ic" aria-hidden="true">{{ GLYPH[x.type] }}</span>
            <span
              ><b>{{ x.title }}</b
              ><span class="sub">{{ x.sub }}</span></span
            >
          </button>
        </li>
        <li v-if="!results.length" class="empty">{{
          t('Nothing in this story matches.')
        }}</li>
      </ul>
    </div>
    <div id="cxScroll" class="cx-scroll">
      <div class="cx-sec cx-chapters">
        <div class="cx-h">{{ t('Chapters') }}</div>
        <ul class="cx-list">
          <li v-for="(c, i) in story.chapters" :key="c.id">
            <a href="#" @click.prevent="emit('chapter', i)"
              >{{ i + 1 }}. {{ chTitle(c) }}</a
            >
            <span
              >{{ chapterStamp(story, c)
              }}{{ i === k ? ` · ${t('now')}` : '' }}</span
            >
          </li>
        </ul>
      </div>

      <div class="cx-sec">
        <div class="cx-h">
          {{ t('About') }}
          <button
            class="tbtn cx-close"
            type="button"
            style="height: 28px; padding: 0 8px"
            @click="emit('hide')"
            >{{ t('Close') }}</button
          >
        </div>
        <p class="cx-p">
          <b>{{ titleOf(story) }}</b
          ><br />{{ t('by {creator}', { creator: story.creator }) }} ·
          {{ windowText(story) }}
        </p>
        <p v-if="story.description" class="cx-p">{{
          storyText(story.description)
        }}</p>
      </div>

      <div v-if="events.length" class="cx-sec">
        <div class="cx-h">{{ t('Key moments') }}</div>
        <ul class="cx-anchors">
          <li v-for="(ev, i) in events" :key="i">
            <button
              type="button"
              :class="{ past: playback.wallMs >= ev.wallMs }"
              @click="emit('anchor', ev)"
            >
              <span class="tchip">{{ stamp(ev.wallMs, ev.tMs) }}</span>
              <span class="al"
                ><i :style="{ background: ev.color }"></i
                >{{ storyText(ev.label) }}</span
              >
            </button>
          </li>
        </ul>
      </div>

      <div v-if="story.sources.length" class="cx-sec">
        <div class="cx-h">{{ t('Sources') }}</div>
        <ul class="cx-list">
          <li v-for="src in story.sources" :key="src[0]">
            <a :href="src[2] || '#'" target="_blank" rel="noopener"
              >{{ storyText(src[0]) }} ↗</a
            >
            <span>{{ storyText(src[1]) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="background" class="cx-sec">
        <div class="cx-h">{{ t('Background') }}</div>
        <p class="cx-p">{{ background }}</p>
      </div>

      <div class="cx-sec">
        <div class="cx-h">{{ t('Related stories') }}</div>
        <div class="cx-related">
          <button
            v-for="x in related"
            :key="x.id"
            type="button"
            @click="emit('open', x.id)"
          >
            <span class="thumb"
              ><img v-if="thumbOf(x)" :src="thumbOf(x)" alt="" loading="lazy"
            /></span>
            <span
              ><b>{{ titleOf(x) }}</b
              ><span class="c-meta">{{ windowText(x) }}</span></span
            >
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>
