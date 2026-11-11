<script setup>
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import {
  FLAP_BLANK,
  FLAP_CHAR_MS,
  FLAP_SETTLE_SLACK_MS,
  SPLIT_FLAP_ENABLED,
  isOnScreen,
  planSplitFlap,
  prefersReducedMotion,
  visibleGlyphs,
} from '../../../splitFlap.js';

// A status label that flips its changed characters into place, planned by
// src/splitFlap.js (read its invariants first). The text is one long-lived
// node whose data is the only thing a change writes; the aria-hidden cells
// stand in for it while a cascade plays and carry their glyphs as generated
// content, so textContent is the settled label at every instant.
const props = defineProps({
  text: { type: String, default: '' },
  // Swap the text without a cascade: a completion, not another stage.
  immediate: { type: Boolean, default: false },
  // Rest at once and stay still: the label's owner is gone.
  stopped: { type: Boolean, default: false },
});

// The label's one Text node. Vue would patch a lone `{{ text }}` child by
// setting textContent, which swaps the node; this writes only its data.
const vFlapText = {
  mounted(el, { value }) {
    el.append(el.ownerDocument.createTextNode(value));
  },
  updated(el, { value }) {
    if (el.firstChild.data !== value) el.firstChild.data = value;
  },
};

const root = ref(null);
// The cascade's columns; each cascade keys its own, so the flaps restart.
const cells = shallowRef([]);
const active = ref(false);
// The width ease, `{width, totalMs}`, or null at the natural width.
const sizing = shallowRef(null);
// The cascade in flight: its plan, start and the one settle timer.
let flap = null;
// Bumped by every change; a stale continuation finds it moved on.
let run = 0;

const now = () => globalThis.performance?.now?.() ?? Date.now();
const measure = () => root.value?.getBoundingClientRect?.().width ?? 0;

function rest() {
  active.value = false;
  cells.value = [];
}

function clearFlap() {
  if (flap) clearTimeout(flap.timer);
  flap = null;
}

/**
 * Ease between two measured widths. The start width lays out before the end
 * width renders, so the transition runs; it ends on transitionend, not a
 * timer. A growing label eases as its cells go in, a shrinking one once the
 * flaps have landed.
 */
async function easeWidth(from, to, totalMs, change) {
  if (!(from > 0.5) || Math.abs(to - from) <= 0.5) {
    sizing.value = null;
    return;
  }
  sizing.value = { width: from, totalMs };
  await nextTick();
  if (change !== run || !root.value) return;
  void root.value.offsetWidth;
  sizing.value = { width: to, totalMs };
}

function endEase(event) {
  if (event.target !== root.value || event.propertyName !== 'width') return;
  sizing.value = null;
}

/** Strip the cells once the cascade lands, then take up any width slack. */
async function settle(change, easeMs) {
  flap = null;
  if (change !== run) return;
  const cascadeWidth = measure();
  sizing.value = null;
  rest();
  await nextTick();
  if (change !== run) return;
  void easeWidth(cascadeWidth, measure(), easeMs, change);
}

// Runs before the label re-renders, while it still shows the old text: what
// was on screen and its width are read here. Whether the label is on screen
// is read once the change has rendered, after its chip shows or hides with it;
// the cells then go in before the browser paints.
watch(
  () => props.text,
  async (next, settled) => {
    const change = ++run;
    // What the viewer sees right now: mid-cascade, columns whose stagger has
    // not elapsed still show the previous label (invariant 3).
    const displayed = flap
      ? visibleGlyphs(flap.plan, now() - flap.startedAt, {
          charMs: FLAP_CHAR_MS,
        })
      : settled;
    clearFlap();
    const beforeWidth = measure();
    sizing.value = null;
    rest();
    if (
      !SPLIT_FLAP_ENABLED ||
      props.immediate ||
      props.stopped ||
      prefersReducedMotion()
    )
      return;
    await nextTick();
    if (change !== run || !isOnScreen(root.value)) return;
    const plan = planSplitFlap(displayed, next);
    if (!plan.changedCount) return;
    // Every column holds its width and index for the whole cascade; one the
    // new string does not reach flaps to a blank (invariant 4).
    cells.value = plan.cells.map((cell) => ({
      key: `${change}:${cell.index}`,
      next: cell.to || FLAP_BLANK,
      prev: cell.changed ? cell.from || FLAP_BLANK : null,
      delay: cell.changed ? `${cell.delayMs}ms` : null,
    }));
    active.value = true;
    flap = {
      plan,
      startedAt: now(),
      timer: setTimeout(
        () => settle(change, plan.durationMs),
        plan.durationMs + FLAP_SETTLE_SLACK_MS,
      ),
    };
    await nextTick();
    if (change !== run) return;
    void easeWidth(beforeWidth, measure(), plan.durationMs, change);
  },
  { flush: 'pre' },
);

function stop() {
  run += 1;
  clearFlap();
}

watch(
  () => props.stopped,
  (stopped) => {
    if (!stopped) return;
    stop();
    sizing.value = null;
    rest();
  },
);

onBeforeUnmount(stop);

const hostStyle = () => ({
  '--gev-flap-dur': active.value ? `${FLAP_CHAR_MS}ms` : null,
  '--gev-flap-total': sizing.value ? `${sizing.value.totalMs}ms` : null,
  width: sizing.value ? `${sizing.value.width}px` : null,
});
</script>

<template>
  <span ref="root" class="gev-flap-host" :class="{ 'gev-flap-active': active, 'gev-flap-sizing': !!sizing }" :style="hostStyle()" @transitionend="endEase" @transitioncancel="endEase"><span v-flap-text="text" class="gev-flap-text"></span><span class="gev-flap-cells" aria-hidden="true"><span v-for="cell in cells" :key="cell.key" class="gev-flap-cell" :class="{ 'is-flapping': cell.prev != null }" :data-flap-next="cell.next" :data-flap-prev="cell.prev ?? undefined" :style="cell.delay ? { '--gev-flap-delay': cell.delay } : undefined"></span></span></span>
</template>
