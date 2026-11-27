<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';
import { radioUnmutePercent } from '../../radioContext.js';

// Radio's volume beside the station heard: the same user volume the Tuner
// fold sets (RadioControls' setRadioVolume, persisted as Radio's params), so
// all of them move together. It is the user's volume, never the level voice
// ducking lowers it to for a while. Muting sets it to zero and unmuting
// brings back the last volume heard.
//
// In a row (Now playing) the slider sits beside the speaker. Compact (the
// mini player) shows the speaker alone; its slider pops up on hover and on
// keyboard focus, and where nothing hovers (touch), a tap on the speaker
// opens the slider, with Mute inside it, instead of muting at once.
const props = defineProps({
  /** The Radio layer's UI state. */
  ui: { type: Object, default: null },
  compact: { type: Boolean, default: false },
});

const radio = useRadioStore();
const percent = computed(() => Math.round((props.ui?.volume ?? radioUnmutePercent.value / 100) * 100));
const muted = computed(() => percent.value === 0);
// A slide down to zero passes every level on its way, so unmuting brings
// back the level the slide started from, not the last step above zero. A
// level still too low to hear brings back half volume.
const AUDIBLE = 5;
let slideFrom = 0;
const slideStart = () => (slideFrom = percent.value);
const slideEnd = () => (slideFrom = 0);
watch(
  percent,
  (value) => {
    if (value > 0) radioUnmutePercent.value = value;
    else if (slideFrom > 0) radioUnmutePercent.value = slideFrom;
    if (value === 0 && radioUnmutePercent.value < AUDIBLE) radioUnmutePercent.value = 50;
  },
  { immediate: true },
);
const setPercent = (value) => radio.act('setRadioVolume', value);
const toggleMute = () => setPercent(muted.value ? radioUnmutePercent.value || 80 : 0);
const sliderName = computed(() => t('Volume, {percent}', { percent: formatNumber(percent.value / 100, { style: 'percent' }) }));
const muteName = computed(() => (muted.value ? t('Unmute radio') : t('Mute radio')));
const glyph = computed(() => (muted.value ? 'volume_off' : 'volume_up'));

// Compact, the slider opens in the page's top layer (a popover), so neither
// Context nor the dock nor any overflow covers it: placed from the speaker,
// above it where there is room, else to its left, inside the window. It
// opens on hover and keyboard focus (on a tap where nothing hovers) and
// closes on leaving, on Escape and on a click elsewhere. While it is open
// it owns Escape (data-owns-escape), so Context leaves that Esc to it.
const root = ref(null);
const speakerButton = ref(null);
// The speaker is a UiButton: its element is the component's root.
const speakerEl = () => speakerButton.value?.$el;
const popup = ref(null);
const open = ref(false);
const side = ref('above');
const GAP = 6;
const EDGE = 8;
const noHover = () => Boolean(globalThis.matchMedia?.('(hover: none)')?.matches);
function place() {
  const el = popup.value;
  const at = speakerEl()?.getBoundingClientRect();
  if (!el || !at) return;
  const box = el.getBoundingClientRect();
  const width = globalThis.innerWidth || 0;
  const height = globalThis.innerHeight || 0;
  const clamp = (value, size, limit) => Math.max(EDGE, Math.min(value, limit - size - EDGE));
  let left;
  let top;
  if (at.top - box.height - GAP >= EDGE) {
    side.value = 'above';
    top = clamp(at.top - box.height - GAP, box.height, height);
    left = clamp(at.right - box.width, box.width, width);
  } else {
    side.value = 'left';
    left = clamp(at.left - box.width - GAP, box.width, width);
    top = clamp(at.top + at.height / 2 - box.height / 2, box.height, height);
  }
  el.style.setProperty('left', `${Math.round(left)}px`);
  el.style.setProperty('top', `${Math.round(top)}px`);
}
function onOutside(event) {
  if (!root.value?.contains(event.target)) hide();
}
let leaveTimer = 0;
let anchorObserver = null;
function show() {
  clearTimeout(leaveTimer);
  if (!props.compact || open.value) return;
  open.value = true;
  try {
    popup.value?.showPopover?.();
  } catch {
    // Already shown, or no top layer: the slider shows in place.
  }
  place();
  globalThis.addEventListener('resize', place);
  globalThis.document?.addEventListener('scroll', place, true);
  if (typeof ResizeObserver === 'function' && speakerEl()) {
    anchorObserver = new ResizeObserver(place);
    anchorObserver.observe(speakerEl());
  }
  globalThis.document?.addEventListener('pointerdown', onOutside, true);
}
function hide() {
  clearTimeout(leaveTimer);
  if (!open.value) return;
  open.value = false;
  try {
    popup.value?.hidePopover?.();
  } catch {
    // Not shown.
  }
  anchorObserver?.disconnect();
  anchorObserver = null;
  globalThis.removeEventListener('resize', place);
  globalThis.document?.removeEventListener('scroll', place, true);
  globalThis.document?.removeEventListener('pointerdown', onOutside, true);
}
// The pointer crosses the small gap between the speaker and the slider.
const hideSoon = () => {
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    if (!root.value?.contains(root.value.ownerDocument.activeElement)) hide();
  }, 200);
};
// Where nothing hovers, the compact speaker discloses the slider (named for
// the volume, its expanded state said) and Mute inside it is the toggle.
const disclosure = () => props.compact && noHover();
function speaker() {
  if (disclosure()) (open.value ? hide : show)();
  else toggleMute();
}
function pointerIn() {
  if (props.compact && !noHover()) show();
}
function pointerOut() {
  if (props.compact && !noHover()) hideSoon();
}
// Focus that a press gives the speaker does not open the slider: the press's
// own click decides (on touch, a tap opens it and the next tap closes it),
// so a first tap never opens it on focus and closes it on its click. Focus
// from the keyboard still opens it.
let pressing = false;
const pressStart = () => (pressing = true);
const pressEnd = () => (pressing = false);
function focusIn() {
  if (!props.compact) return;
  if (pressing) return void pressEnd();
  show();
}
function focusOut(event) {
  if (!root.value?.contains(event.relatedTarget)) hide();
}
function escape(event) {
  if (!open.value) return;
  // This Esc is the slider's alone: the panel around it (Context, expanded)
  // must not also collapse on it.
  event.preventDefault();
  event.stopPropagation();
  // Focus goes back to the speaker first, so its focus does not reopen it.
  speakerEl()?.focus();
  hide();
}
onBeforeUnmount(hide);
</script>

<template>
  <div ref="root" class="radio-volume" :class="{ 'radio-volume--compact': compact, 'is-open': open }" :data-owns-escape="open || undefined" @pointerdown.capture="pressStart" @click.capture="pressEnd" @focusin="focusIn" @focusout="focusOut" @keydown.esc="escape" @mouseenter="pointerIn" @mouseleave="pointerOut">
    <UiButton ref="speakerButton" class="radio-volume__mute" :pressed="disclosure() ? undefined : muted" :aria-label="disclosure() ? t('Radio volume') : muteName" :aria-expanded="disclosure() ? String(open) : undefined" :title="disclosure() ? t('Radio volume') : muteName" @click="speaker">
      <UiIcon :name="glyph" :size="null" />
    </UiButton>
    <div ref="popup" class="radio-volume__slider" :popover="compact ? 'manual' : undefined" :data-side="compact ? side : undefined" @mouseenter="pointerIn" @mouseleave="pointerOut">
      <UiSlider class="radio-volume__range" hold min="0" max="100" :model-value="percent" :aria-label="sliderName" @update:model-value="setPercent" @pointerdown="slideStart" @focus="slideStart" @blur="slideEnd" />
      <UiButton v-if="compact && open && noHover()" class="radio-volume__mute" :pressed="muted" :aria-label="muteName" @click="toggleMute">
        <UiIcon :name="glyph" :size="null" />
      </UiButton>
    </div>
  </div>
</template>
