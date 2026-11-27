<script setup>
import { computed } from 'vue';
import { t } from '../../i18n/index.js';
import ContextListCard from '../kit/ContextListCard.vue';
import UiButton from '../kit/UiButton.vue';
import UiCloseButton from '../kit/UiCloseButton.vue';
import UiSegmented from '../kit/UiSegmented.vue';
import RailCardBlocks from '../rail/RailCardBlocks.vue';
import RailCards from '../rail/RailCards.vue';
import RecentImageryCard from './RecentImageryCard.vue';
import UiSlider from '../kit/UiSlider.js';

// Every block exists from the start, in its final order. The owner computes
// the view and listens on the root; a mode choice calls `onSetMode`.
const props = defineProps({
  view: { type: Object, required: true },
  modes: { type: Array, required: true },
  onOpenDetails: { type: Function, default: () => {} },
  onDrawArea: { type: Function, default: () => {} },
  onSetMode: { type: Function, default: () => {} },
});
const modeOptions = computed(() =>
  props.modes.map(([mode, label]) => ({
    value: mode,
    label: t(label),
    attrs: { 'data-mode': mode },
  })),
);
</script>

<template>
  <section
    class="recent-imagery-readout"
    :aria-label="t('Recent imagery')"
    :hidden="view.hidden"
    :data-mode="view.mode"
    :data-owns-escape="view.ownsEscape || undefined"
    ><div id="ri-actions" class="ri-block ri-actions-row"
      ><RailCardBlocks :blocks="view.actions" card-id="recent-imagery" /></div
    ><div
      id="ri-notice"
      :class="[
        'ri-block ri-line ri-notice',
        {
          warn: view.notice.warn,
          info: view.notice.info,
          'has-action': view.notice.fit,
        },
      ]"
      ><span
        id="ri-notice-text"
        class="ri-notice-text"
        role="status"
        aria-live="polite"
        :title="view.notice.text"
        >{{ view.notice.text }}</span
      ><UiButton
        id="ri-zoom-in"
        :class="[
          'data-toggle-chip ri-zoom-in',
          { 'is-reserved': !view.notice.fit },
        ]"
        :title="t('Fly in until the view fits the 1,000 km limit')"
        :disabled="!view.notice.fit"
        :aria-hidden="String(!view.notice.fit)"
        >{{ t('ZOOM IN') }}</UiButton
      ></div
    ><ContextListCard
      id="recent-imagery"
      class="ri-block ri-strip"
      :title="t('Recent imagery')"
      icon="satellite_alt"
      :tone="view.strip.tone"
      :items="view.strip.cards"
      :item-key="(card) => card.key"
      :state="view.strip.state"
      :aria-keyshortcuts="
        view.strip.state === 'ready' && view.strip.cards.length
          ? view.mode === 'ab'
            ? 'A B'
            : 'A S'
          : undefined
      "
      :row-button="false"
      ><template #row="{ item }"><RecentImageryCard :card="item" /></template
      ><template #loading>{{ t('Searching') }}</template
      ><template #empty
        ><UiButton
          v-if="view.strip.draw"
          id="ri-draw-area"
          class="data-toggle-chip ri-draw-area"
          :disabled="Boolean(view.strip.draw.disabled)"
          @click="onDrawArea"
          >{{ view.strip.draw.label }}</UiButton
        ><template v-else>{{ view.strip.empty }}</template></template
      ></ContextListCard
    ><div id="ri-hint" class="ri-block ri-line ri-hint" :title="view.hint">{{
      view.hint
    }}</div
    ><section
      id="ri-selection"
      class="ri-block ri-selection"
      :aria-label="t('On the map')"
      :data-mode="view.mode"
      ><UiSegmented
        id="ri-mode"
        class="ri-mode"
        item-class="ri-mode-btn"
        keyboard="arrows"
        :label="t('Mode')"
        :options="modeOptions"
        :model-value="view.mode"
        @update:model-value="onSetMode" /><div
        v-for="slot in view.slots"
        :id="`ri-slot-${slot.id}`"
        :key="slot.id"
        :class="['ri-slot', { lit: slot.lit }]"
        :data-state="slot.state"
        ><span class="ri-slot-tag">{{ slot.tag }}</span
        ><span class="ri-slot-value" :title="slot.text">{{ slot.text }}</span
        ><UiCloseButton
          :id="`ri-unpin-${slot.id}`"
          :class="[
            'data-toggle-chip ri-unpin',
            { 'is-reserved': !slot.pinned },
          ]"
          :data-unpin="slot.id"
          :disabled="!slot.pinned"
          :aria-hidden="String(!slot.pinned)"
          :label="slot.unpinLabel"
          :title="slot.unpinLabel" /></div></section
    ><div id="ri-controls" class="ri-block ri-controls"
      ><label class="ri-opacity-label" for="ri-opacity"
        ><span>{{ t('OPACITY') }}</span
        ><span class="ri-opacity-value">{{ view.alpha }}%</span></label
      ><UiSlider
        id="ri-opacity"
        :model-value="view.alpha"
        class="ri-opacity"
        min="0"
        max="100"
        step="1"
        :aria-label="t('Imagery opacity')"
        :disabled="!view.opacityEnabled" /><UiButton
        id="ri-swap"
        :class="[
          'data-toggle-chip ri-swap',
          { 'is-reserved': !view.swap.live },
        ]"
        :title="t('Trade the two sides of the divider')"
        :disabled="!view.swap.live"
        :aria-hidden="String(!view.swap.live)"
        :pressed="Boolean(view.swap.pressed)"
        pressed-class="active"
        >{{ t('SWAP') }}</UiButton
      ><div class="ri-exports"
        ><RailCardBlocks
          :blocks="view.exports"
          card-id="recent-imagery" /></div></div
    ><div id="ri-details" class="ri-details"
      ><RailCards
        :cards="view.details"
        card-class-name="ri-details-card"
        :on-open="onOpenDetails" /></div
  ></section>
</template>
