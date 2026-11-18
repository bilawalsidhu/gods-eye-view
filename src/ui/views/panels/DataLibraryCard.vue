<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import {
  coverageText,
  imagerySpecs,
  libraryBadges,
  libraryReasonText,
} from '../../libraryBrowser.js';

// One Data Library entry in Browse, as src/ui/libraryBrowser.js lists it:
// what it is, who provides it under what licence, what this instance needs
// to serve it, and Add / Remove / Zoom. The parent keys cards by entry id, so
// a card (and its focused button) survives Add becoming Remove.
const props = defineProps({ row: { type: Object, required: true } });
const emit = defineEmits(['add', 'remove', 'zoom']);

const entry = computed(() => props.row.entry);
const reason = computed(() => libraryReasonText(props.row));
const actionLabel = computed(() =>
  props.row.added
    ? t('Remove {name} from Data Layers', { name: entry.value.title })
    : t('Add {name} to Data Layers', { name: entry.value.title }),
);
</script>

<template>
  <li
    class="data-library-item"
    :class="{
      'is-unavailable': !row.available,
      'is-on': entry.kind !== 'pack' && row.added && row.on,
    }"
    :data-library-id="entry.id"
  >
    <div class="data-library-item-head">
      <span class="data-library-icon" aria-hidden="true">{{ entry.icon }}</span>
      <span class="data-library-name">{{ entry.title }}</span>
      <span class="data-library-badges">
        <span
          v-for="badge in libraryBadges(entry)"
          :key="badge.label"
          class="data-library-badge"
          :class="badge.tone ? `data-library-badge--${badge.tone}` : undefined"
          >{{ badge.label }}</span
        >
      </span>
    </div>
    <p class="data-library-description">{{ entry.description }}</p>
    <dl v-if="entry.imagery" class="data-library-specs">
      <div
        v-for="spec in imagerySpecs(entry)"
        :key="spec.label"
        class="data-library-spec"
      >
        <dt>{{ spec.label }}</dt>
        <dd>{{ spec.value }}</dd>
      </div>
    </dl>
    <p class="data-library-meta">
      <span translate="no">{{ entry.provider }}</span> ·
      <span>{{ coverageText(entry) }}</span> ·
      <a :href="entry.licence.url" target="_blank" rel="noopener noreferrer">{{
        entry.licence.name
      }}</a>
    </p>
    <p v-if="reason" class="data-library-reason">{{ reason }}</p>
    <div v-if="entry.kind !== 'pack'" class="data-library-actions">
      <UiButton
        v-if="row.added && row.canZoom"
        class="panel-surface-control data-library-action"
        :data-library-id="entry.id"
        data-library-action="zoom"
        :disabled="row.busy"
        :label="t('Zoom to {name}', { name: entry.title })"
        :native-title="false"
        @click="emit('zoom', entry.id)"
        >{{ t('ZOOM') }}</UiButton
      >
      <UiButton
        class="panel-surface-control data-library-action"
        :data-library-id="entry.id"
        :data-library-action="row.added ? 'remove' : 'add'"
        :disabled="row.busy || (!row.added && !row.available)"
        :label="actionLabel"
        :native-title="false"
        @click="emit(row.added ? 'remove' : 'add', entry.id)"
        >{{ row.busy ? t('WORKING…') : row.added ? t('REMOVE') : t('ADD') }}</UiButton
      >
    </div>
  </li>
</template>
