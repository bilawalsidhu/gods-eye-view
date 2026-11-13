<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useStoriesStore } from '../../stores/stories.js';
import { chapterAt } from '../../../stories/format.js';
import {
  chapterTitle,
  clamp,
  clockText,
  fmtDur,
  storyText,
} from '../../../stories/storyMeta.js';

/**
 * The story timeline (prototype `.timeline`): chapter segments with
 * magnetic ticks, key-moment pips, a scrub bubble, sound and expand.
 * Positions are wall milliseconds on the GEV scene's own clock.
 */
const props = defineProps({ story: { type: Object, required: true } });
const emit = defineEmits(['anchor']);
const store = useStoriesStore();
const { playback, muted, expanded } = storeToRefs(store);

const dur = computed(
  () => playback.value.durationMs || props.story.durationMs || 1,
);
const tNow = computed(() => playback.value.wallMs);
const pct = computed(() => clamp((tNow.value / dur.value) * 100, 0, 100));
const k = computed(() => chapterAt(props.story, tNow.value));
const chapters = computed(() => props.story.chapters);
const chTitle = (c) => chapterTitle(props.story, c);
const events = computed(() => props.story.events ?? []);
const seek = (ms) => store.controller.seek(clamp(ms, 0, dur.value - 10));

// ── Play button: pause while playing, resume while exploring, otherwise play ──
const ICON = {
  pause:
    '<rect x="6.5" y="5" width="4" height="14" rx="1.4"/><rect x="13.5" y="5" width="4" height="14" rx="1.4"/>',
  play: '<path d="M8 5.7v12.6c0 .9 1 1.4 1.7.9l9.7-6.3a1.1 1.1 0 0 0 0-1.8L9.7 4.8C9 4.3 8 4.8 8 5.7Z"/>',
  resume:
    '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M3.5 3.8v4.6h4.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
};
const playMode = computed(() =>
  playback.value.exploring && !playback.value.playing
    ? 'resume'
    : playback.value.playing
      ? 'pause'
      : 'play',
);
function togglePlay() {
  if (playMode.value === 'resume') store.controller.resume();
  else if (playback.value.playing) store.controller.pause();
  else store.controller.play();
}

// ── Segments ──
const segs = computed(() =>
  chapters.value.map((c, i) => {
    const a = (c.wallMs / dur.value) * 100;
    const next =
      i + 1 < chapters.value.length ? chapters.value[i + 1].wallMs : dur.value;
    const b = (next / dur.value) * 100;
    const fill =
      clamp((tNow.value - c.wallMs) / (next - c.wallMs || 1), 0, 1) * 100;
    return {
      i,
      style: {
        left: `calc(${a}% + ${i ? 2 : 0}px)`,
        width: `calc(${b - a}% - ${i ? 2 : 0}px - ${i + 1 < chapters.value.length ? 2 : 0}px)`,
      },
      fill: `${fill}%`,
    };
  }),
);

// ── Readout ──
const clock = computed(() =>
  clockText(props.story, tNow.value, playback.value.worldMs, k.value),
);
const stampAt = (ms) => fmtDur(ms);
const headTime = computed(() => `${fmtDur(tNow.value)} / ${fmtDur(dur.value)}`);
const atEdge = computed(
  () => props.story.live && tNow.value >= dur.value - 600,
);

// ── Scrubbing: magnetic chapter ticks, momentum, haptic ticks ──
const track = ref(null);
const scrubbing = ref(false);
const snap = ref(-1);
const hovered = ref(-1);
const ghost = ref(0);
const bubbleAt = ref(null);
let sc = null;
let coastRaf = 0;
let pipSnap = -1;
const reduceMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const haptic = () => {
  try {
    navigator.vibrate?.(3);
  } catch {
    /* no haptics here */
  }
};
function trackAt(clientX) {
  const r = track.value.getBoundingClientRect();
  let u = clamp((clientX - r.left) / r.width, 0, 1);
  let snapped = -1;
  chapters.value.forEach((c, i) => {
    if (i && Math.abs(u - c.wallMs / dur.value) * r.width < 9) {
      u = c.wallMs / dur.value;
      snapped = i;
    }
  });
  return { t: u * dur.value, snapped };
}
function scrubTo(target) {
  const w = track.value.getBoundingClientRect().width || 1;
  let tt = clamp(target, 0, dur.value - 10);
  let snapped = -1;
  chapters.value.forEach((c, i) => {
    if (i && (Math.abs(tt - c.wallMs) / dur.value) * w < 6) {
      tt = c.wallMs;
      snapped = i;
    }
  });
  let pip = -1;
  if (snapped < 0)
    events.value.forEach((ev, i) => {
      if ((Math.abs(tt - ev.wallMs) / dur.value) * w < 5) {
        tt = ev.wallMs;
        pip = i;
      }
    });
  if (pip >= 0 && pip !== pipSnap) haptic();
  pipSnap = pip;
  if (pip >= 0) snapped = -2 - pip;
  const ch = chapterAt(props.story, tt);
  if (sc && ch !== sc.ch) {
    haptic();
    sc.ch = ch;
  }
  seek(tt);
  snap.value = snapped;
  bubbleAt.value = tt;
  return snapped >= 0 || snapped <= -2 ? Math.max(0, snapped) : -1;
}
function onDown(e) {
  if (e.target.closest('.tl-pip')) return;
  try {
    track.value.setPointerCapture(e.pointerId);
  } catch {
    /* nothing to capture */
  }
  cancelAnimationFrame(coastRaf);
  scrubbing.value = true;
  const r = trackAt(e.clientX);
  sc = {
    lastX: e.clientX,
    lastT: performance.now(),
    v: 0,
    ch: chapterAt(props.story, r.t),
    at: r.t,
  };
  seek(r.t);
  snap.value = r.snapped;
  bubbleAt.value = r.t;
}
function onMove(e) {
  if (!scrubbing.value) {
    if (e.target.closest('.tl-pip')) return;
    const r = trackAt(e.clientX);
    ghost.value = (r.t / dur.value) * 100;
    hovered.value = chapterAt(props.story, r.t);
    snap.value = r.snapped;
    if (r.snapped < 0) {
      const w = track.value.clientWidth || 1;
      const i = events.value.findIndex(
        (ev) => (Math.abs(ev.wallMs - r.t) / dur.value) * w < 5,
      );
      if (i >= 0) snap.value = -2 - i;
    }
    bubbleAt.value = r.t;
    return;
  }
  // Slow drags are fine, fast drags coarse.
  const now = performance.now();
  const dx = e.clientX - sc.lastX;
  const dtm = Math.max(1, now - sc.lastT);
  const w = track.value.getBoundingClientRect().width || 1;
  const gain = clamp(0.25 + (Math.abs(dx) / dtm) * 1.1, 0.25, 2.5);
  const before = sc.at;
  sc.at = clamp(sc.at + (dx / w) * dur.value * gain, 0, dur.value - 10);
  scrubTo(sc.at);
  sc.v = (sc.at - before) / dtm;
  sc.lastX = e.clientX;
  sc.lastT = now;
}
function onUp() {
  scrubbing.value = false;
  snap.value = -1;
  pipSnap = -1;
  if (
    !sc ||
    reduceMotion() ||
    Math.abs(sc.v) < 2 ||
    performance.now() - sc.lastT > 120
  ) {
    sc = null;
    return;
  }
  // A release coasts with momentum, stopping on a chapter tick.
  let v = sc.v * 16;
  let at = sc.at;
  const coast = () => {
    at += v;
    const hit = scrubTo(at);
    v *= 0.92;
    if (hit >= 0 || Math.abs(v) < 20 || at <= 0 || at >= dur.value - 20) {
      snap.value = -1;
      sc = null;
      return;
    }
    coastRaf = requestAnimationFrame(coast);
  };
  coastRaf = requestAnimationFrame(coast);
}
function onLeave() {
  if (scrubbing.value) return;
  ghost.value = 0;
  hovered.value = -1;
  snap.value = -1;
  bubbleAt.value = null;
}

// The bubble follows the knob while playing and the pointer while hovering.
const bubbleT = computed(() => bubbleAt.value ?? tNow.value);
const bubbleK = computed(() => chapterAt(props.story, bubbleT.value));
const bubbleClock = computed(() =>
  clockText(
    props.story,
    bubbleT.value,
    bubbleAt.value == null ? playback.value.worldMs : null,
    bubbleK.value,
  ),
);
const bubbleEm = computed(() => {
  if (snap.value >= 0) return { text: t('Chapter start'), color: null };
  if (snap.value <= -2) {
    const ev = events.value[-2 - snap.value];
    return ev ? { text: storyText(ev.label), color: ev.color } : null;
  }
  return null;
});
const bubbleEl = ref(null);
const bubbleStyle = computed(() => {
  const w = track.value?.clientWidth || 1;
  const half = (bubbleEl.value?.offsetWidth || 120) / 2;
  const x = (bubbleT.value / dur.value) * w;
  const bx = clamp(x, half, Math.max(half, w - half));
  return {
    left: `${bx}px`,
    '--caret': `${clamp(x - bx + half, 8, half * 2 - 8)}px`,
  };
});
// The bubble's picture: the story's card picture, when it has one.
const prevSrc = computed(() => store.thumbs?.[props.story.id] || '');
const prevCanvas = ref(null);
function drawPreview() {
  const cv = prevCanvas.value;
  const src = prevSrc.value;
  if (!cv || !src) return;
  const img = new Image();
  img.onload = () =>
    cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
  img.src = src;
}
watch(prevSrc, drawPreview, { flush: 'post' });
onMounted(drawPreview);

// ── Key moments ──
const tip = ref(null);
function tipFor(i) {
  const ev = events.value[i];
  if (!ev) return;
  const w = track.value?.clientWidth || 1;
  tip.value = {
    ev,
    left: clamp((ev.wallMs / dur.value) * w, 90, Math.max(90, w - 90)),
  };
}
function pipClick(i) {
  haptic();
  emit('anchor', events.value[i]);
  setTimeout(() => (tip.value = null), 900);
}

// ── Keyboard on the track ──
function goChapter(i) {
  seek(chapters.value[i].wallMs + 1);
  if (playback.value.exploring) store.controller.resume();
}
// Previous goes to the start of this chapter first, like a video player.
function stepChapter(d) {
  const kk = k.value;
  const list = chapters.value;
  if (d > 0 && kk === list.length - 1) {
    seek(dur.value);
    return;
  }
  const to =
    d > 0
      ? Math.min(list.length - 1, kk + 1)
      : tNow.value - list[kk].wallMs > 1500
        ? kk
        : Math.max(0, kk - 1);
  goChapter(to);
}
function onKey(e) {
  if (e.target !== track.value) return;
  // A key the timeline handles is the timeline's alone.
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  let tt = tNow.value;
  if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    stepChapter(e.key === 'ArrowRight' ? 1 : -1);
    handled();
    return;
  }
  if (e.key === 'PageUp') tt += dur.value / 10;
  else if (e.key === 'PageDown') tt -= dur.value / 10;
  else if (/^[0-9]$/.test(e.key)) tt = dur.value * (+e.key / 10);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') tt += 2000;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') tt -= 2000;
  else if (e.key === 'Home') tt = 0;
  else if (e.key === 'End') tt = dur.value;
  else if (e.key === ']') {
    goChapter(Math.min(chapters.value.length - 1, k.value + 1));
    handled();
    return;
  } else if (e.key === '[') {
    goChapter(Math.max(0, k.value - 1));
    handled();
    return;
  } else if (e.key === ' ' || e.key === 'Enter') {
    togglePlay();
    handled();
    return;
  } else return;
  handled();
  seek(tt);
}

// ── Sound, expand ──
const VOL = {
  off: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  on: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
};
function toggleExpand() {
  store.expanded = !store.expanded;
  store.ctxOpen = false;
  setTimeout(() => store.controller.reframe(), 320);
}
function jumpLive() {
  seek(dur.value);
  if (playback.value.exploring) store.controller.resume();
}

onBeforeUnmount(() => cancelAnimationFrame(coastRaf));
defineExpose({ goChapter });
</script>

<template>
  <div id="timeline" class="timeline" :data-kind="story.live ? 'live' : ''">
    <button
      id="tlPlay"
      class="tl-play"
      :class="{ resume: playMode === 'resume' }"
      type="button"
      :aria-label="
        playMode === 'resume'
          ? t('Resume story')
          : playMode === 'pause'
            ? t('Pause')
            : t('Play')
      "
      @click="togglePlay"
    >
      <svg
        id="tlIcon"
        viewBox="0 0 24 24"
        fill="currentColor"
        v-html="ICON[playMode]"
      ></svg>
    </button>
    <div
      id="tlTrack"
      ref="track"
      class="tl-track"
      :class="{ dragging: scrubbing, 'on-pip': !!tip }"
      role="slider"
      tabindex="0"
      :aria-label="t('Story time')"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(pct)"
      :aria-valuetext="`${clock.big}, ${t('chapter')} ${k + 1}: ${chTitle(chapters[k])}`"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="onLeave"
      @keydown="onKey"
    >
      <div class="tl-rail">
        <div id="tlFill" class="tl-fill" :style="{ width: `${pct}%` }"></div>
      </div>
      <div id="tlTicks">
        <span
          v-for="s in segs"
          :key="s.i"
          class="tl-seg"
          :class="{ now: s.i === k, hov: s.i === hovered, snap: s.i === snap }"
          :data-k="s.i"
          :style="s.style"
          ><i :style="{ width: s.fill }"></i
        ></span>
      </div>
      <div
        id="tlGhost"
        class="tl-ghost"
        :style="{ width: `${ghost}%` }"
        aria-hidden="true"
      ></div>
      <div id="tlHead" class="tl-head" aria-hidden="true">
        <span id="tlHeadCh"
          ><b>{{ k + 1 }}</b
          >/{{ chapters.length }} · {{ chTitle(chapters[k]) }}</span
        >
        <span id="tlHeadTime">{{ headTime }}</span>
      </div>
      <div id="tlPips" role="group" :aria-label="t('Key moments')">
        <button
          v-for="(ev, i) in events"
          :key="i"
          type="button"
          class="tl-pip"
          :class="{ snap: snap === -2 - i }"
          :data-e="i"
          :aria-label="t('Key moment: {label}', { label: storyText(ev.label) })"
          :style="{ left: `${(ev.wallMs / dur) * 100}%`, color: ev.color }"
          @pointerdown.stop
          @pointerover="tipFor(i)"
          @pointerout="tip = null"
          @focus="tipFor(i)"
          @blur="tip = null"
          @click.stop="pipClick(i)"
          @keydown.space.stop
          @keydown.enter.stop
        >
          <i :style="{ background: ev.color }"></i>
        </button>
      </div>
      <div
        v-if="tip"
        id="tlTip"
        class="tl-tip"
        role="tooltip"
        :style="{ left: `${tip.left}px` }"
      >
        <i :style="{ background: tip.ev.color }"></i
        ><b>{{ storyText(tip.ev.label) }}</b
        ><span>{{ stampAt(tip.ev.wallMs) }}</span>
      </div>
      <div class="tl-knob" :style="{ left: `${pct}%` }"></div>
      <div
        id="tlBubble"
        ref="bubbleEl"
        class="tl-bubble"
        :data-snap="snap >= 0 ? 'ch' : snap <= -2 ? 'pip' : ''"
        :style="bubbleStyle"
      >
        <canvas
          v-if="prevSrc"
          id="tlPrev"
          ref="prevCanvas"
          width="320"
          height="180"
          aria-hidden="true"
        ></canvas>
        <div id="tlBubbleTxt">
          <b>{{ bubbleK + 1 }} · {{ chTitle(chapters[bubbleK]) }}</b>
          <span class="tt">{{ bubbleClock.big }}</span>
          <em
            v-if="bubbleEm"
            :style="bubbleEm.color ? { color: bubbleEm.color } : null"
            >{{ bubbleEm.text }}</em
          >
        </div>
      </div>
    </div>
    <span id="tlTime" class="tl-time" aria-hidden="true">
      <b v-if="story.live">{{ clock.big }}</b>
      <span v-else class="tt-c">{{ headTime }}</span>
    </span>
    <button
      v-if="story.live"
      id="tlLive"
      class="tl-live"
      :class="{ edge: atEdge }"
      type="button"
      :aria-label="t('Jump to live')"
      @click="jumpLive"
    >
      <i></i>{{ t('LIVE') }}
    </button>
    <button
      id="tlVol"
      class="tl-vol"
      type="button"
      :aria-label="muted ? t('Unmute') : t('Mute')"
      :aria-pressed="!muted"
      @click="muted = !muted"
    >
      <svg
        id="tlVolIcon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        v-html="muted ? VOL.off : VOL.on"
      ></svg>
    </button>
    <button
      id="stExpand"
      class="tl-vol"
      type="button"
      :aria-label="expanded ? t('Exit expanded map') : t('Expand map')"
      :aria-pressed="expanded"
      @click="toggleExpand"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
      </svg>
    </button>
  </div>
</template>
