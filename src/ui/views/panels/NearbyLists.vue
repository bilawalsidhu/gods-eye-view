<script setup>
import { onBeforeUpdate, onUpdated, ref } from 'vue';
import { sayWords, useEntityCardStore } from '../../stores/entityCard.js';
import { focusInCard, focusedRow, replacementRow } from '../../cardFocus.js';
import { formatNumber, t } from '../../../i18n/index.js';
import { shownLayerName } from '../../layerNames.js';
import { approximatePosition, distanceText as distance } from '../../distanceText.js';
import AirportLink from './AirportLink.vue';
import EntityMark from './EntityMark.vue';
import { markKind } from '../../entityMark.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// A row opened here hands focus to the new card's title.
const props = defineProps({
  /** From the store's `nearbyLayers`. */
  lists: { type: Array, required: true },
  /** Shown on the line above the lists. */
  title: { type: String, default: '' },
  approximate: Boolean,
  rowsOnly: Boolean,
  externalFocus: Boolean,
  selectItem: { type: Function, default: null },
});

const store = useEntityCardStore();
const pick = (item, event) => {
  if (props.selectItem) return props.selectItem(item, event);
  if (store.open(item.identity)) void focusInCard([], store);
};

// What a moving item is doing, as the layer's own display shows it (transit
// vehicles report it): an icon on its row, its words on hover.
const MOTION_STATES = {
  moving: { icon: 'play_arrow', label: () => t('Moving') },
  stopped: { icon: 'pause', label: () => t('Stopped', { context: 'vehicle motion' }) },
  waiting: { icon: 'schedule', label: () => t('Waiting for update') },
  'no-fix': { icon: 'location_off', label: () => t('No recent fix') },
};
const motionOf = (item) => MOTION_STATES[item.identity?.record?.motion] || null;

// A row may name an airport beside it (`via`: an arrival's origin, a
// departure's destination), its code a link to that airport's card. The words
// around the code come from the whole phrase, so each language keeps its own
// order ("from SDF", "SDF から").
const CODE_MARK = '\u0001';
const VIA_WORDS = {
  from: () => t('from {origin}', { origin: CODE_MARK }),
  to: () => t('to {destination}', { destination: CODE_MARK }),
};
function viaWords(via) {
  const phrase = VIA_WORDS[via.words]?.() || CODE_MARK;
  const at = phrase.indexOf(CODE_MARK);
  return at < 0 ? { before: '', after: '' } : { before: phrase.slice(0, at), after: phrase.slice(at + CODE_MARK.length) };
}

// The lists refresh every few seconds. A focused row, or the airport named
// beside it, that drops out of them hands focus on: to the same control where
// it is drawn again, else to its row, else to the row now in its place (or its
// group's last), else to the heading, so the keyboard is never sent back to
// the page. When the last row goes and the section with it, `focus-lost` asks
// the view around it to take the focus.
const emit = defineEmits(['focus-lost']);
const root = ref(null);
let held = null;
onBeforeUpdate(() => {
  if (props.externalFocus) return;
  const active = globalThis.document?.activeElement;
  if (active && active === root.value?.querySelector('.nearby-lists__title')) {
    held = { heading: true };
    return;
  }
  held = focusedRow(root.value, active);
});
onUpdated(() => {
  const was = held;
  held = null;
  if (!was) return;
  // Only focus that fell back to the page is moved.
  const active = globalThis.document?.activeElement;
  if (active && active !== globalThis.document.body) return;
  const section = root.value;
  if (!section) {
    emit('focus-lost');
    return;
  }
  if (was.heading) {
    section.querySelector('.nearby-lists__title')?.focus();
    return;
  }
  const next = replacementRow(section, was, 'button[data-via-key]') || section.querySelector('.nearby-lists__title');
  next?.focus?.();
});
</script>

<template>
  <section v-if="lists.some((list) => list.items.length)" ref="root" class="nearby-lists" :aria-label="title || t('What’s nearby')">
    <h4 v-if="!rowsOnly" class="nearby-lists__title" tabindex="-1">{{ title || t('What’s nearby') }}</h4>
    <template v-for="list in lists" :key="list.layerId">
      <div v-if="list.items.length" class="nearby-lists__layer" :data-layer="list.layerId">
        <h5 v-if="!rowsOnly" class="nearby-lists__head">
          <UiIcon :name="list.icon" :size="null" />
          <span>{{ shownLayerName(list.layerName, list.layerId) }}</span>
          <span class="nearby-lists__count"><template v-if="list.layerId === 'traffic'">{{ t('Road segments') }} · </template>{{ list.countLabel ?? formatNumber(list.count) }}</span>
        </h5>
        <ul>
          <li v-for="(item, index) in list.items" :key="item.key" :class="{ 'nearby-lists__row--nearest': index === 0, 'nearby-lists__row--via': item.via }">
            <UiButton
              :data-row-key="item.key"
              :data-row-layer="list.layerId"
              :data-row-index="index"
              @click="pick(item, $event)"
            >
              <UiIcon
                v-if="motionOf(item)"
                :name="motionOf(item).icon"
                :size="null"
                class="nearby-lists__motion"
                :data-motion="item.identity.record.motion"
                :title="motionOf(item).label()"
                role="img"
                :aria-label="motionOf(item).label()"
                :aria-hidden="null"
              />
              <EntityMark class="nearby-lists__mark" :layer="list.layerId" :kind="markKind(list.layerId, item.identity?.record)" :icon="list.icon" :size="16" />
              <span class="nearby-lists__name" :title="sayWords(item.titleWords, item.title)">{{ sayWords(item.titleWords, item.title) }}</span>
              <span v-if="item.estimateReason" class="nearby-lists__badge" :title="item.estimateReason">{{ t('approximate') }}</span>
              <span v-if="index === 0" class="nearby-lists__badge">{{ t('Nearest') }}</span>
              <span class="nearby-lists__meta">{{ distance(item.distanceKm, approximate || approximatePosition(item.identity?.record)) }}</span>
            </UiButton>
            <span v-if="item.via" class="nearby-lists__via">{{ viaWords(item.via).before }}<AirportLink :code="item.via.code" :data-via-key="item.key" :data-row-layer="list.layerId" :data-row-index="index" />{{ viaWords(item.via).after }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
