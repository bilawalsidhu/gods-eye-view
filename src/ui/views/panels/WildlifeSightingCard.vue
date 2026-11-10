<script setup>
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import { formatDate, t, translateKnown } from '../../../i18n/index.js';
import { photoCreator, formatAge } from '../../../layers/wildlifeSightings/photoText.js';
import { ACARTIA_SITE, inatLicenceLabel, inatPhotoUrl, isOpenPhoto } from '../../../layers/wildlifeSightings/records.js';

const props = defineProps({
  sighting: { type: Object, required: true },
  nowMs: { type: Number, required: true },
  taxa: { type: String, default: 'all' },
});
const emit = defineEmits(['close', 'resize']);
const acartia = computed(() => props.sighting.origin === 'acartia');
const name = computed(() => translateKnown(props.sighting.commonName || props.sighting.scientificName) || t('SIGHTING'));
const scientificName = computed(() => translateKnown(props.sighting.scientificName || ''));
const photo = computed(() => {
  const row = props.sighting;
  if (row.obscured || acartia.value || !isOpenPhoto(row.photo)) return null;
  const src = inatPhotoUrl(row.photo.square ?? row.photo.url, 'medium');
  const creator = photoCreator(row.photo);
  return src && creator ? { src, creator, licence: inatLicenceLabel(row.photo.license_code ?? row.photo.licence) } : null;
});
const observedDay = computed(() => {
  const row = props.sighting;
  const day = row.observedOn || (!row.obscured && Number.isFinite(row.observedAt) ? new Date(row.observedAt).toISOString().slice(0, 10) : '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : '';
});
const age = computed(() => {
  const row = props.sighting;
  const delta = props.nowMs - row.observedAt;
  if (row.obscured || !Number.isFinite(row.observedAt) || delta >= 30 * 86_400_000) return '';
  const compact = formatAge(Math.max(0, delta));
  return acartia.value ? t('seen {age} ago', { age: compact }) : t('observed {age} ago', { age: compact });
});
const observedDate = computed(() => observedDay.value ? formatDate(Date.parse(`${observedDay.value}T00:00:00Z`), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const link = computed(() => {
  // The "Acartia" label only ever points at the Acartia site, never a row URL.
  if (acartia.value) return ACARTIA_SITE;
  try {
    const url = new URL(props.sighting.link);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
});
const providerCredit = computed(() => {
  if (!acartia.value) return '';
  const { name = '', entity = '' } = props.sighting.provider || {};
  return entity ? t('Reported by {name} ({entity})', { name, entity }) : t('Reported by {name}', { name });
});
const actionLabel = computed(() => acartia.value ? t('Open {name} on Acartia', { name: name.value }) : t('Open {name} on iNaturalist', { name: name.value }));
const photoImage = useTemplateRef('photoImage');
const loaded = shallowRef(false);
const failed = shallowRef(false);
const currentImage = (image) => image === photoImage.value && image?.dataset.sightingId === props.sighting.stableId && image?.getAttribute('src') === photo.value?.src;
async function onPhotoLoad(event) {
  const image = event.currentTarget;
  // Ignore late decodes after a different observation replaces this photo.
  try { await image.decode?.(); } catch { /* onload is sufficient on older engines */ }
  if (!currentImage(image)) return;
  loaded.value = true;
  emit('resize');
}
function fail(event) {
  if (!currentImage(event.currentTarget)) return;
  failed.value = true;
  emit('resize');
}
watch([() => props.sighting.stableId, () => photo.value?.src], () => { loaded.value = false; failed.value = false; }, { flush: 'sync' });
</script>

<template>
  <section class="wildlife-sighting-card" data-wildlife-sighting-card tabindex="-1" :aria-label="name" @keydown.stop @keyup.stop>
    <button type="button" class="wildlife-sighting-card-close" :aria-label="t('Close sighting')" @click="emit('close')">×</button>
    <component :is="link ? 'a' : 'div'" class="wildlife-sighting-card-content" :href="link || undefined" :target="link ? '_blank' : undefined" :rel="link ? 'noopener noreferrer' : undefined" :aria-label="link ? actionLabel : undefined">
      <div v-if="photo" class="wildlife-sighting-card-photo" :aria-busy="!loaded && !failed">
        <p v-if="!loaded && !failed" role="status">{{ t('Loading photo...') }}</p>
        <p v-if="failed" role="status">{{ t('Photo unavailable') }}</p>
        <img v-show="!failed" ref="photoImage" :key="sighting.stableId + photo.src" :data-sighting-id="sighting.stableId" :src="photo.src" :alt="t('Photo of {name}', { name })" referrerpolicy="no-referrer" :class="{ loaded }" @load="onPhotoLoad" @error="fail" />
      </div>
      <div class="wildlife-sighting-card-caption">
        <h2>{{ name }}</h2>
        <p v-if="scientificName && scientificName !== name"><i>{{ scientificName }}</i></p>
        <p v-if="age || observedDay"><time :datetime="observedDay || undefined">{{ age || observedDate }}</time></p>
        <p v-if="sighting.obscured">{{ t('Location obscured to a 0.2° cell') }}</p>
        <!-- i18n-ignore: creator and licence are provider attribution, copied verbatim -->
        <p v-if="photo" class="wildlife-sighting-card-credit">© {{ photo.creator }} · {{ photo.licence }}</p>
        <p v-if="providerCredit" class="wildlife-sighting-card-credit">{{ providerCredit }}</p>
        <p v-if="acartia" class="wildlife-sighting-card-credit">{{ t('Acartia') }} · {{ t('CC BY 4.0') }} · {{ t('Salish Sea') }}</p>
        <p v-if="link" class="wildlife-sighting-card-source">{{ acartia ? t('Acartia') : t('iNaturalist') }} ↗</p>
      </div>
    </component>
    <p v-if="acartia || taxa === 'whales'" class="wildlife-sighting-card-guidance">
      <a href="https://www.bewhalewise.org" target="_blank" rel="noopener noreferrer">{{ t('Be Whale Wise') }}</a>
    </p>
  </section>
</template>

<style scoped>
.wildlife-sighting-card {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-height: inherit;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--glass-border-hover);
  border-radius: var(--btn-radius);
  background: var(--menu-bg);
  color: var(--text-primary);
  font: 11px/1.4 var(--font-mono);
  box-shadow: 0 3px 16px rgb(0 0 0 / 30%);
}
.wildlife-sighting-card-content { display: block; color: inherit; text-decoration: none; }
.wildlife-sighting-card-content:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
/* Script focus starts inside the card; tab focus still outlines its controls. */
.wildlife-sighting-card:focus-visible { outline: none !important; }
.wildlife-sighting-card-close { position: absolute; z-index: 1; inset-block-start: 4px; inset-inline-end: 4px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--btn-radius); background: transparent; color: inherit; font: 20px/1 var(--font-sans); cursor: pointer; }
.wildlife-sighting-card-close:hover { background: var(--menu-bg); }
.wildlife-sighting-card-close:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 2px; }
.wildlife-sighting-card-photo { position: relative; width: 100%; height: 180px; }
.wildlife-sighting-card-photo > p { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; }
.wildlife-sighting-card-photo > img { display: block; width: 100%; height: 100%; object-fit: contain; opacity: 0; }
.wildlife-sighting-card-photo > img.loaded { opacity: 1; }
.wildlife-sighting-card-caption { padding-top: 6px; overflow-wrap: anywhere; }
.wildlife-sighting-card-caption h2, .wildlife-sighting-card-caption p { margin: 0 0 3px; }
.wildlife-sighting-card-caption h2 { padding-inline-end: 20px; font: inherit; font-weight: 700; }
.wildlife-sighting-card-credit { color: var(--text-secondary); }
.wildlife-sighting-card-guidance { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 4px 0 0; color: var(--text-secondary); }
.wildlife-sighting-card-guidance a { color: inherit; }
.wildlife-sighting-card-source { text-decoration: underline; text-underline-offset: 2px; }
</style>
