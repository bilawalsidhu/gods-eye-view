<script setup>
import { storeToRefs } from 'pinia';
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import { formatCockpitCoordinate } from '../../cockpitPresentation.js';
import { useCockpitStore } from '../../stores/cockpit.js';

// The mapped points the orbital view shows or can be turned to, under its
// readout: ground points of the layers that are on, nearest to nadir first.
// A row opens the point's details (its OpenStreetMap tags where the layer
// keeps them); FOCUS keeps the camera on it, switches to it from another, or
// ends the focus held on it. The Cockpit controller builds the list
// (src/ui/cockpitOrbitalFocus.js) and keeps FOCUS's delegated listener;
// which rows are open is this view's own.

const { orbitalReach } = storeToRefs(useCockpitStore());

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const entries = computed(() => orbitalReach.value?.entries || []);
const count = computed(() =>
  finite(orbitalReach.value?.count) ? orbitalReach.value.count : 0,
);
const open = ref(false);
const selectedKey = ref(null);
const root = useTemplateRef('root');

const toggleText = computed(() =>
  t('IN REACH · {count}', { count: formatNumber(count.value) }),
);
const moreText = computed(() =>
  count.value > entries.value.length
    ? t('NEAREST {shown} OF {count}', {
        shown: formatNumber(entries.value.length),
        count: formatNumber(count.value),
      })
    : '',
);

const angleText = (deg) =>
  finite(deg)
    ? `${formatNumber(deg, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°`
    : '—';
const positionText = (entry) =>
  finite(entry.latitude) && finite(entry.longitude)
    ? `${formatCockpitCoordinate(entry.latitude, 'N', 'S')} ${formatCockpitCoordinate(entry.longitude, 'E', 'W')}`
    : '—';

function toggleDetails(key) {
  selectedKey.value = selectedKey.value === key ? null : key;
}

// A point that leaves the list closes its details. Keyboard focus inside
// its row moves to the list's toggle, which stays, instead of the page.
watch(
  entries,
  (list) => {
    const key = selectedKey.value;
    const active = document.activeElement;
    const row = active?.closest?.('[data-orbital-reach-key]');
    const leaving =
      row &&
      root.value?.contains(row) &&
      !list.some((entry) => entry.key === row.dataset.orbitalReachKey);
    if (key !== null && !list.some((entry) => entry.key === key))
      selectedKey.value = null;
    if (leaving)
      nextTick(() =>
        root.value
          ?.querySelector('#cockpit-orbital-reach-toggle')
          ?.focus({ preventScroll: true }),
      );
  },
  { flush: 'pre' },
);
</script>

<template>
  <section ref="root" class="cockpit-orbital-reach" :aria-label="t('Mapped points in reach')">
    <button id="cockpit-orbital-reach-toggle" type="button" class="cockpit-orbital-reach-toggle" :aria-expanded="String(open)" aria-controls="cockpit-orbital-reach-body" :aria-label="open ? t('Hide the mapped points in reach') : t('Show the mapped points in reach')" :title="open ? t('Hide the mapped points in reach') : t('Show the mapped points in reach')" @click="open = !open">{{ toggleText }}</button>
    <div v-show="open" id="cockpit-orbital-reach-body" class="cockpit-orbital-reach-body">
      <p v-if="!entries.length" class="cockpit-orbital-reach-empty">{{ t('NOTHING MAPPED IN REACH') }}</p>
      <ul v-else class="cockpit-orbital-reach-list">
        <li v-for="entry in entries" :key="entry.key" class="cockpit-orbital-reach-item" :class="{ 'cockpit-orbital-reach-focused': entry.focused }" :data-orbital-reach-key="entry.key">
          <div class="cockpit-orbital-reach-row">
            <button type="button" class="cockpit-orbital-reach-name" :aria-expanded="String(selectedKey === entry.key)" :aria-controls="selectedKey === entry.key ? 'cockpit-orbital-reach-details' : undefined" @click="toggleDetails(entry.key)">
              <strong>{{ entry.label }}</strong>
              <small>{{ entry.layerName }}<template v-if="entry.layerName"> · </template>{{ angleText(entry.offNadirDeg) }}</small>
            </button>
            <button type="button" class="cockpit-orbital-reach-focus" :data-orbital-focus="entry.key" :aria-pressed="String(entry.focused)" :aria-disabled="entry.reachable ? undefined : 'true'" :aria-label="t('Keep the camera on {name}', { name: entry.label })" :title="entry.reachable ? t('Keep the camera on {name}', { name: entry.label }) : t('Beyond the off-nadir reach')">{{ t('FOCUS') }}</button>
          </div>
          <div v-if="selectedKey === entry.key" id="cockpit-orbital-reach-details" class="cockpit-orbital-reach-details">
            <p class="cockpit-orbital-reach-where">{{ positionText(entry) }}<template v-if="entry.source"> · {{ entry.source }}</template></p>
            <template v-if="entry.details.length">
              <p class="cockpit-orbital-reach-kicker">{{ entry.osm ? t('OPENSTREETMAP TAGS') : t('DETAILS') }}</p>
              <dl class="cockpit-orbital-reach-tags" translate="no">
                <div v-for="row in entry.details" :key="row.key" class="cockpit-orbital-reach-tag">
                  <dt>{{ row.key }}</dt>
                  <dd>{{ row.value }}</dd>
                </div>
              </dl>
            </template>
          </div>
        </li>
      </ul>
      <p v-if="moreText" class="cockpit-orbital-reach-more">{{ moreText }}</p>
    </div>
  </section>
</template>
