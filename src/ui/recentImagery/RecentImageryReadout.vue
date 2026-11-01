<script setup>
import { t } from '../../i18n/index.js';
import RailCardBlocks from '../rail/RailCardBlocks.vue';
import RailCards from '../rail/RailCards.vue';
import { vRangeValue } from '../rail/rangeValue.js';
import RecentImageryCard from './RecentImageryCard.vue';

// Every block exists from the start, in its final order. The owner computes
// the view and listens on the root; the mode buttons are painted by its
// segmented control.
defineProps({
  view: { type: Object, required: true },
  modes: { type: Array, required: true },
  onOpenDetails: { type: Function, default: () => {} },
});
</script>

<template>
  <section
    class="recent-imagery-readout"
    :aria-label="t('Recent imagery')"
    :hidden="view.hidden"
    :data-mode="view.mode"
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
      ><button
        id="ri-zoom-in"
        :class="[
          'data-toggle-chip ri-zoom-in',
          { 'is-reserved': !view.notice.fit },
        ]"
        type="button"
        :title="t('Fly in until the view fits the 1,000 km limit')"
        :disabled="!view.notice.fit"
        :aria-hidden="String(!view.notice.fit)"
        >{{ t('ZOOM IN') }}</button
      ></div
    ><div
      id="ri-strip"
      :class="[
        'ri-block ri-strip ui-scroll',
        { searching: view.strip.searching },
      ]"
      tabindex="0"
      role="listbox"
      aria-orientation="horizontal"
      :aria-label="
        t('Imagery days, newest first · arrows move, S or A and B pin')
      "
      aria-keyshortcuts="A B S"
      :aria-activedescendant="view.strip.activeDescendant || undefined"
      ><RecentImageryCard
        v-for="card in view.strip.cards"
        :key="card.key"
        :card="card"
      /><div class="ri-strip-empty" :hidden="view.strip.cards.length > 0">{{
        view.strip.empty
      }}</div></div
    ><div id="ri-hint" class="ri-block ri-line ri-hint" :title="view.hint">{{
      view.hint
    }}</div
    ><section
      id="ri-selection"
      class="ri-block ri-selection"
      :aria-label="t('On the map')"
      :data-mode="view.mode"
      ><div
        id="ri-mode"
        class="gev-segmented ri-mode"
        role="radiogroup"
        :aria-label="t('Mode')"
        ><button
          v-for="[mode, label] in modes"
          :key="mode"
          class="gev-segment ri-mode-btn"
          type="button"
          :data-mode="mode"
          role="radio"
          >{{ t(label) }}</button
        ></div
      ><div
        v-for="slot in view.slots"
        :id="`ri-slot-${slot.id}`"
        :key="slot.id"
        :class="['ri-slot', { lit: slot.lit }]"
        :data-state="slot.state"
        ><span class="ri-slot-tag">{{ slot.tag }}</span
        ><span class="ri-slot-value" :title="slot.text">{{ slot.text }}</span
        ><button
          :id="`ri-unpin-${slot.id}`"
          :class="[
            'data-toggle-chip ri-unpin',
            { 'is-reserved': !slot.pinned },
          ]"
          type="button"
          :data-unpin="slot.id"
          :disabled="!slot.pinned"
          :aria-hidden="String(!slot.pinned)"
          :aria-label="slot.unpinLabel"
          :title="slot.unpinLabel"
          >×</button
        ></div
      ></section
    ><div id="ri-controls" class="ri-block ri-controls"
      ><label class="ri-opacity-label" for="ri-opacity"
        ><span>{{ t('OPACITY') }}</span
        ><span class="ri-opacity-value">{{ view.alpha }}%</span></label
      ><input
        id="ri-opacity"
        v-range-value="view.alpha"
        type="range"
        class="gev-quantitative-slider ri-opacity"
        min="0"
        max="100"
        step="1"
        :aria-label="t('Imagery opacity')"
        :disabled="!view.opacityEnabled" /><button
        id="ri-swap"
        :class="[
          'data-toggle-chip ri-swap',
          {
            'is-reserved': !view.swap.live,
            active: view.swap.pressed,
          },
        ]"
        type="button"
        :title="t('Trade the two sides of the divider')"
        :disabled="!view.swap.live"
        :aria-hidden="String(!view.swap.live)"
        :aria-pressed="String(view.swap.pressed)"
        >{{ t('SWAP') }}</button
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
