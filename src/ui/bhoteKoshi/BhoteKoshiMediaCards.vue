<script setup>
import { t } from '../../i18n/index.js';

// The Bhote Koshi event's embedded media cards and the hidden YouTube
// preload, as src/data/bhoteKoshiEmbeddedMedia.js presents them inside its
// overlay root. The owner renders synchronously on every change and places
// each card beside its map anchor after each frame (its position, its
// leader's line and whether it shows); a card's player is filled by the
// provider: the YouTube frame drawn here, or the Facebook player and X post
// the provider SDKs build inside it. The card's body takes taps (the root
// and the leader do not); Stories keeps that.
defineProps({
  /** `{key, src, title}` of the hidden YouTube preload, or null. */
  warm: { type: Object, default: null },
  /**
   * The cards in insertion order: `{id, provider, portrait, entering,
   * leaving, unavailable, label, title, status, url, frame, bind}`; `frame`
   * is `{src, title, onLoad}` for a YouTube card and null otherwise, and
   * `bind(name, element)` hands the owner the elements it places and fills.
   */
  cards: { type: Array, default: () => [] },
});
</script>

<template>
  <iframe
    v-if="warm"
    :key="warm.key"
    class="bhote-embedded-media-warmup"
    :src="warm.src"
    :title="warm.title"
    tabindex="-1"
    aria-hidden="true"
    loading="eager"
    referrerpolicy="strict-origin-when-cross-origin"
  ></iframe>
  <section
    v-for="card in cards"
    :key="card.id"
    :ref="(el) => card.bind('card', el)"
    class="bhote-embedded-callout"
    :class="[
      `is-${card.provider}`,
      {
        'is-portrait': card.portrait,
        'is-entering': card.entering,
        'is-leaving': card.leaving,
        'is-unavailable': card.unavailable,
      },
    ]"
    :data-provider="card.provider"
    :aria-label="card.label"
  >
    <svg
      :ref="(el) => card.bind('leader', el)"
      class="bhote-embedded-callout-leader"
      aria-hidden="true"
    >
      <path
        pathLength="1"
        fill="none"
        stroke="rgba(147,213,228,.72)"
        stroke-width="1.5"
      />
      <circle r="4" fill="#6be8ff" stroke="#ffffff" stroke-width="1.5" />
    </svg>
    <div class="bhote-embedded-callout-body" data-overlay-input>
      <div
        v-if="card.frame"
        :ref="(el) => card.bind('player', el)"
        class="bhote-embedded-callout-player ui-scroll"
      >
        <iframe
          :ref="(el) => card.bind('frameElement', el)"
          :src="card.frame.src"
          :title="card.frame.title"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowfullscreen
          loading="eager"
          referrerpolicy="strict-origin-when-cross-origin"
          @load.once="card.frame.onLoad"
        ></iframe>
      </div>
      <div
        v-else
        :ref="(el) => card.bind('player', el)"
        class="bhote-embedded-callout-player ui-scroll"
      ></div>
      <footer>
        <strong>{{ card.title }}</strong>
        <small role="status">{{ card.status }}</small>
        <a :href="card.url" target="_blank" rel="noopener noreferrer">{{
          t('OPEN ORIGINAL ↗')
        }}</a>
      </footer>
    </div>
  </section>
</template>
