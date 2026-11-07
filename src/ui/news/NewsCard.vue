<script setup>
import { ref, watch } from 'vue';
import { t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';

// One event in the News panel: the publisher's
// picture when the event has one, the headline, a mono meta line (severity
// marker, category, place, sources, age), who reported it, its attestation
// and media chips, and the service it came through ("via …"), which some ask
// to be credited wherever their reports show. A click chooses it (the layer
// flies there and opens its card on the globe); open, it plays the post's
// clip when it has one (on request, with sound and controls), and shows the
// summary, the other sides' reports and the link to the original article.
// The layer computes every value shown (feedCardView in
// src/layers/news/model.js).
const props = defineProps({
  item: { type: Object, required: true },
  open: { type: Boolean, default: false },
  onChoose: { type: Function, default: () => {} },
  onClear: { type: Function, default: () => {} },
});

// A picture the publisher no longer serves leaves the card without one.
const pictureFailed = ref(false);
const dropPicture = () => {
  pictureFailed.value = true;
};
// So does a clip whose signed link has expired.
const clipFailed = ref(false);
const dropClip = () => {
  clipFailed.value = true;
};
watch(
  () => props.item.picture?.url,
  () => {
    pictureFailed.value = false;
    clipFailed.value = false;
  },
);
const meta = () =>
  [
    props.item.category,
    props.item.place &&
      (props.item.placedByModel
        ? t('{place} (placed by model)', { place: props.item.place })
        : props.item.place),
    props.item.sources,
    props.item.age,
  ]
    .filter(Boolean)
    .join(' · ');
</script>

<template>
  <article
    class="news-card"
    :class="{ 'is-open': open, 'is-unmapped': !item.mappable }"
    :data-report-id="item.id"
    :style="{ '--news-color': item.color }"
  >
    <button
      type="button"
      class="news-card__main ui-focus"
      :aria-expanded="open ? 'true' : 'false'"
      @click="onChoose(item)"
    >
      <span v-if="item.picture && !pictureFailed" class="news-card__thumb"
        ><img
          :src="item.picture.url"
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          v-on="{ error: dropPicture }"
        /><span
          v-if="item.picture.video && !clipFailed"
          class="news-card__play"
          role="img"
          :aria-label="t('Video')"
          >▶</span
        ><span v-if="item.picture.credit" class="news-card__credit">{{
          item.picture.credit
        }}</span></span
      >
      <span class="news-card__title">{{ item.title }}</span>
      <span v-if="item.original" class="news-card__note">{{
        t('English headline by the model')
      }}</span>
      <span class="news-card__meta ui-mono"
        ><span
          class="news-card__marker"
          :class="{ solid: item.solid }"
          role="img"
          :aria-label="item.severityLabel"
          :title="item.severityLabel"
          ><svg viewBox="0 0 16 16" aria-hidden="true">
            <path :d="item.icon" /></svg></span
        ><span v-if="item.severity >= 2" class="news-card__severity">{{
          item.severityLabel
        }}</span
        >{{ item.severity >= 2 ? ` · ${meta()}` : meta() }}</span
      >
      <span v-if="item.sides" class="news-card__sides">{{ item.sides }}</span>
      <span v-if="item.chips.length" class="news-card__chips"
        ><span
          v-for="chip in item.chips"
          :key="`${chip.kind}:${chip.label}`"
          class="news-chip"
          :class="`news-chip--${chip.kind}`"
          >{{ chip.label }}</span
        ></span
      >
      <span v-if="item.via" class="news-card__via ui-mono">{{ item.via }}</span>
    </button>
    <div v-if="open" class="news-card__open">
      <video
        v-if="item.picture?.video && !clipFailed"
        class="news-card__clip"
        :src="item.picture.video"
        :poster="pictureFailed ? undefined : item.picture.url"
        controls
        playsinline
        preload="none"
        referrerpolicy="no-referrer"
        v-on="{ error: dropClip }"
      ></video>
      <p v-if="item.original" class="news-card__original">{{
        item.original
      }}</p>
      <p v-if="item.snippet" class="news-card__snippet">{{ item.snippet }}</p>
      <p v-if="!item.mappable" class="news-card__note">
        {{ t('Not placed on the map') }}
      </p>
      <ul v-if="item.others.length" class="news-card__others">
        <li v-for="other in item.others" :key="other.url">
          <span class="news-card__side ui-mono">{{ other.side }}</span
          ><a :href="other.url" target="_blank" rel="noopener noreferrer"
            >{{ other.publisher }}: {{ other.title }}</a
          >
        </li>
      </ul>
      <div class="news-card__actions">
        <a
          class="news-card__link"
          :href="item.url"
          target="_blank"
          rel="noopener noreferrer"
          >{{ item.sourceLink }}</a
        >
        <UiButton
          class="data-toggle-chip news-card__clear"
          type="button"
          @click="onClear()"
          >{{ t('Close') }}</UiButton
        >
      </div>
    </div>
  </article>
</template>
