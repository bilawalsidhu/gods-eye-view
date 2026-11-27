<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { msg, t } from '../../../i18n/index.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { useRadioStore } from '../../stores/radio.js';
import { stationCategory, stationFailureText, stationPin, stationPinKey, stationPlayback, toggleStation } from '../../radioContext.js';
import { pinnedStationMiss, playPinnedStation } from '../../pinnedStation.js';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import FeedDot from './FeedDot.vue';
import RadioVolume from './RadioVolume.vue';
import MarqueeText from './MarqueeText.vue';

// A station pinned during playback survives Clear all, Radio off, and picks
// until Close or another station plays. Unpinning only removes the pin.
// With Radio off, playback uses the loaded catalog without enabling the layer.
const props = defineProps({
  module: { type: Object, default: null },
  ui: { type: Object, default: null },
  listStations: { type: Array, default: null },
});
// `closed` (the click): the player is gone, so Context takes the focus a
// keyboard Close leaves behind.
const emit = defineEmits(['closed']);

const privacyId = useId();
const privacyNote = computed(() => t('Stations play straight from their broadcasters, who see your IP address.'));
const pinned = usePinnedStore();
const radio = useRadioStore();
const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);

const keepPinned = (id) => pinned.isPinned(stationPinKey(id));
// The station heard that was pinned at some point of this playback; it
// stays kept until another station plays or the player closes it.
const keptId = ref(null);
watch(
  () => [props.ui?.playingStationId ?? null, pinned.pins.length],
  ([heardId]) => {
    if (keptId.value && keptId.value !== heardId) keptId.value = null;
    if (heardId && keepPinned(heardId)) keptId.value = heardId;
  },
  { immediate: true },
);
// The layer asks, as it turns off, whether to keep the station heard.
const keepStream = (id) => keepPinned(id) || id === keptId.value;
watch(
  () => props.module,
  (next, previous) => {
    if (previous && previous !== next) previous.keepStreamWhenOff?.(null);
    next?.keepStreamWhenOff?.(keepStream);
  },
  { immediate: true },
);
onBeforeUnmount(() => props.module?.keepStreamWhenOff?.(null));

const HEARD = ['loading', 'buffering', 'playing', 'paused', 'error'];
// With Radio off, Previous or Next moves the selection: the player shows the
// station stepped to, ready to play, never the one it stepped from. It
// follows the selection until it is closed.
const followsStep = ref(false);
// The station heard (or paused, or failed); else the one selected (with
// Radio off, only a pinned one); else a pinned station ready to play. With
// the local receiver chosen, Context shows only the receiver: no internet
// station, pinned or not.
const station = computed(() => {
  const ui = props.ui;
  if (!props.module || !ui || ui.source === 'local') return null;
  if (ui.playingStation && HEARD.includes(ui.audioState)) return ui.playingStation;
  const selected = ui.selected;
  if (selected && (ui.enabled || keepStream(selected.id) || followsStep.value)) return selected;
  const pins = pinned.pins.filter((pin) => pin.kind === 'station' && pin.identity?.id);
  if (!pins.length) return null;
  const pin = pins.find((each) => each.identity.id === selected?.id) || pins.at(-1);
  return { id: pin.identity.id, name: pin.title, lat: pin.identity.lat, lon: pin.identity.lon };
});
const playback = computed(() => stationPlayback(props.ui, station.value?.id));
const sounding = computed(() => playback.value === 'live' || playback.value === 'loading');
// Loading or buffering is not live yet: the loading dot says so ("Loading").
const dot = computed(() => playback.value === 'idle' ? '' : playback.value);
const failure = computed(() =>
  playback.value === 'lost' ? stationFailureText(props.ui) : '',
);

// Closed, the player stays away until a station is chosen or starts again.
const dismissed = ref(false);
watch(
  () => [props.ui?.selected?.id ?? null, sounding.value],
  ([selectedId, nowSounding], previous) => {
    if (!previous) return;
    if (selectedId !== previous[0] || (nowSounding && !previous[1])) dismissed.value = false;
  },
);
const shown = computed(() => Boolean(station.value) && !dismissed.value);
const name = computed(() => station.value?.name || '');
const missing = computed(() => pinnedStationMiss.value && pinnedStationMiss.value.id === station.value?.id
  ? t('{name} is not in the station directory right now', { name: name.value }) : '');
// The station's category tints the radio glyph, as its marker is coloured.
const category = computed(() => stationCategory(props.module, props.ui, station.value));

// Close stops the station heard, pinned or not, and puts the player away.
function close(event) {
  if (props.ui?.playingStationId && HEARD.includes(props.ui.audioState)) props.module?.stopPlayback?.({ origin: 'user' });
  keptId.value = null;
  followsStep.value = false;
  dismissed.value = true;
  emit('closed', event);
}

const isPinned = computed(() => Boolean(station.value && keepPinned(station.value.id)));
const pinLabel = computed(() => isPinned.value
  ? t('Unpin {name}', { name: name.value })
  : t('Pin {name} to the Pinned tab', { name: name.value }));
function togglePin() {
  const current = station.value;
  if (!current) return;
  // Unpinning changes only the pin: the station plays on.
  if (isPinned.value) return void pinned.unpin(stationPinKey(current.id));
  // Pinning shows Pinned, so the new tile is in view.
  chrome.act('reveal', 'global-context-panel');
  if (panels.value['global-context-panel']?.collapsed !== false) chrome.act('toggle', 'global-context-panel');
  pinned.pin(stationPin(current));
  pinned.show('pinned');
}

function playOrPause() {
  const current = station.value;
  if (!current) return;
  if (!sounding.value && isPinned.value) return void playPinnedStation({ id: current.id, name: current.name }, { module: () => props.module });
  toggleStation(props.module, props.ui, current.id);
}

// With the list visible, step through every matching station in list order.
// Else use the tuner's band or the offline station selection.
const canStep = computed(() => (props.listStations?.length ?? props.ui?.filteredCount ?? 0) > 1);
function step(direction) {
  if (!canStep.value) return;
  if (props.ui?.enabled && props.ui?.presentationActive) {
    if (props.listStations) {
      props.module.cycleStation(direction, {
        stationIds: props.listStations.map(({ id }) => id),
        rotate: true,
        autoplay: sounding.value,
        origin: 'user',
      });
    } else radio.act('cycleRadio', direction);
  } else if (props.module?.stepStationWhileOff?.(direction, { origin: 'user' })) followsStep.value = true;
}

// What the player is doing, said as its group's name.
const groupLabel = computed(() => {
  const state = { loading: msg('Loading'), paused: msg('Paused'), lost: msg('Broadcaster stream unavailable') }[playback.value];
  if (state) return t('{name}: {state}', { name: t('Radio playback'), state: t(state) });
  return playback.value === 'live' ? t('Radio playing') : t('Radio station');
});
</script>

<template>
  <div v-if="shown" class="radio-mini" :data-state="playback" role="group" :aria-label="groupLabel" :aria-describedby="privacyId">
    <span :id="privacyId" hidden>{{ privacyNote }}</span>
    <UiIcon class="radio-mini__icon" name="radio" :size="null" :style="category ? { color: category.color } : undefined" :title="category?.label" />
    <FeedDot v-if="dot" :state="dot" />
    <span class="radio-mini__name" :title="missing || failure || name">
      <span v-if="missing" class="radio-mini__miss" role="status">{{ missing }}</span>
      <MarqueeText v-else :text="name" :titled="false" />
    </span>
    <div class="radio-mini__controls">
      <UiButton class="radio-mini__pin" :pressed="isPinned" pressed-class="is-on" :aria-label="pinLabel" :title="pinLabel" @click="togglePin">
        <UiIcon name="keep" :size="null" />
      </UiButton>
      <UiButton :aria-label="t('Previous filtered station')" :title="privacyNote" data-chip-icon="skip_previous" :disabled="!canStep" @click="step(-1)">
        <UiIcon name="skip_previous" :size="null" />
      </UiButton>
      <UiButton
        class="radio-mini__play"
        :aria-label="sounding ? t('Pause {name}', { name }) : t('Play {name}', { name })"
        :title="privacyNote"
        @click="playOrPause"
      >
        <UiIcon :name="sounding ? 'pause' : 'play_arrow'" :size="null" />
      </UiButton>
      <UiButton :aria-label="t('Next filtered station')" :title="privacyNote" data-chip-icon="skip_next" :disabled="!canStep" @click="step(1)">
        <UiIcon name="skip_next" :size="null" />
      </UiButton>
      <UiCloseButton class="radio-mini__close" glyph="icon" :label="t('Close the radio player')" :title="t('Close the radio player')" @click="close($event)" />
      <RadioVolume :ui="ui" compact />
    </div>
  </div>
</template>
