<script setup>
import { storeToRefs } from 'pinia';
import { computed, nextTick, ref, watch } from 'vue';
import { formatNumber, getLocale, t } from '../../../i18n/index.js';
import {
  formatCockpitCoordinate,
  formatTleEpochUtc,
  tleAgeParts,
} from '../../cockpitPresentation.js';
import {
  ownerMark,
  preloadOwnerFlags,
  regionName,
  shownOwnerMark,
} from '../../ownerFlag.js';
import { useCockpitStore } from '../../stores/cockpit.js';

// The orbital view's HUD: a nadir reticle over the picture, the satellite's
// identity and orbit, and the optical zoom. The Cockpit controller presents
// it, drives the zoom step's blur and lock tick, and keeps the zoom buttons'
// listeners; this view only reflects the store.

const { orbital } = storeToRefs(useCockpitStore());

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const altitudeText = computed(() => {
  const altitudeM = orbital.value?.altitudeM;
  return finite(altitudeM)
    ? t('{value} KM', {
        value: formatNumber(Math.round(altitudeM / 1000)),
      })
    : '—';
});

const velocityText = computed(() => {
  const velocityMps = orbital.value?.velocityMps;
  return finite(velocityMps)
    ? t('{value} KM/S', {
        value: formatNumber(velocityMps / 1000, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      })
    : null;
});

const subPointText = computed(() => {
  const { latitude, longitude } = orbital.value || {};
  if (!finite(latitude) || !finite(longitude)) return '—';
  return `${formatCockpitCoordinate(latitude, 'N', 'S')} ${formatCockpitCoordinate(longitude, 'E', 'W')}`;
});

const zoomSteps = computed(() => orbital.value?.zoomSteps || [1]);
const zoom = computed(() => orbital.value?.zoom ?? zoomSteps.value[0]);
// The SENSOR step lands between ladder steps, e.g. 5.7×.
const zoomText = computed(() =>
  t('ZOOM {zoom}×', {
    zoom: formatNumber(zoom.value, { maximumFractionDigits: 1 }),
  }),
);
const maxZoom = computed(
  () => orbital.value?.maxZoom ?? Math.max(...zoomSteps.value),
);
const atWidest = computed(() => zoom.value <= Math.min(...zoomSteps.value));
const atTightest = computed(() => zoom.value >= maxZoom.value);

// The imaging sensor's swath: a strip drawn to scale across the view, its
// width as a readout, and the SENSOR step that zooms the view to it. Off
// nadir the strip stays, the readout scales as the view's swath does (≈),
// and the SENSOR step, a nadir framing, is hidden.
const sensor = computed(() => orbital.value?.sensor || null);
// Track-up turns the frame to the ground track; north's pointer turns back.
const trackUp = computed(() => orbital.value?.trackUp === true);
const northPointerStyle = computed(() => {
  const northDeg = orbital.value?.northDeg;
  return finite(northDeg) && northDeg !== 0
    ? { transform: `rotate(${northDeg.toFixed(1)}deg)` }
    : null;
});
// The N itself stays upright as its pointer turns.
const northLetterStyle = computed(() => {
  const northDeg = orbital.value?.northDeg;
  return finite(northDeg) && northDeg !== 0
    ? { transform: `translateX(-50%) rotate(${(-northDeg).toFixed(1)}deg)` }
    : null;
});

const sensorStripStyle = computed(() => {
  const fraction = sensor.value?.stripFraction;
  return finite(fraction) && fraction > 0
    ? { width: `${(fraction * 100).toFixed(3)}%` }
    : null;
});
const sensorText = computed(() => {
  const km = sensor.value?.swathKm;
  if (!finite(km)) return '';
  const look = orbital.value?.look;
  if (look?.offset === true) {
    const scale = look.swathScale;
    if (!finite(scale)) return '';
    return t('SENSOR SWATH ≈ {value} KM', {
      value: formatNumber(km * scale, { maximumFractionDigits: 1 }),
    });
  }
  // As published: 13.1 km, 185 km.
  return t('SENSOR SWATH {value} KM', {
    value: formatNumber(km, { maximumFractionDigits: 1 }),
  });
});
const sensorStepShown = computed(
  () =>
    finite(sensor.value?.zoom) &&
    finite(orbital.value?.footprintKm) &&
    orbital.value?.look?.offset !== true,
);

// A focused control that turns off (a zoom button at the end of its range,
// SENSOR as the view tilts away) hands focus on instead of dropping it to the
// page. The watchers run before the re-render, while it still has focus.
const zoomInButton = ref(null);
const zoomOutButton = ref(null);
const sensorButton = ref(null);
const nadirButton = ref(null);
const handFocus = (from, to) => {
  if (!from || document.activeElement !== from) return;
  nextTick(() =>
    (to() ?? document.getElementById('map-view-switch'))?.focus({
      preventScroll: true,
    }),
  );
};
watch(
  atTightest,
  (now) => now && handFocus(zoomInButton.value, () => zoomOutButton.value),
  { flush: 'pre' },
);
watch(
  atWidest,
  (now) => now && handFocus(zoomOutButton.value, () => zoomInButton.value),
  { flush: 'pre' },
);
watch(
  sensorStepShown,
  (shown) => !shown && handFocus(sensorButton.value, () => nadirButton.value),
  { flush: 'pre' },
);

// At nadir the footprint; tilted, the approximate width at the view's
// centre, marked ≈.
const swathText = computed(() => {
  const tilted = orbital.value?.look?.offset === true;
  const km = tilted ? orbital.value?.look?.swathKm : orbital.value?.footprintKm;
  if (!finite(km)) return '';
  const digits = km < 10 ? 1 : 0;
  const value = formatNumber(km, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return tilted
    ? t('SWATH ≈ {value} KM', { value })
    : t('SWATH {value} KM', { value });
});

// What the sub-satellite point is over: nothing until the first lookup
// lands; on land the division as Natural Earth names it and the country in
// the reader's language, with the populated place in view from 8x; at sea
// the Natural Earth name.
const placeText = computed(() => {
  const place = orbital.value?.place;
  if (place === undefined) return '';
  // No feature holds the point (a gap at a simplified coastline): say
  // nothing rather than call land open ocean.
  if (!place) return '';
  if (place.kind !== 'country') return place.name || '';
  const country =
    (place.countryCode && regionName(place.countryCode, getLocale())) ||
    place.name ||
    '';
  const region = place.division
    ? t('{division}, {country}', { division: place.division, country })
    : country;
  return place.near
    ? t('{region} · near {place}', { region, place: place.near })
    : region;
});

// The owner's flag, or a text badge for an owner without one.
const mark = computed(() =>
  ownerMark(orbital.value?.owner, { locale: getLocale() }),
);
// The flag sheet loads at startup; a sheet that would not load (offline, a
// stale asset after a deploy) is asked again for the next flag, and until it
// comes the code shows as a badge, never no owner at all.
const flagsReady = ref(false);
const flagsFailed = ref(false);
watch(
  // Keyed on the satellite too: after a failed load, the next ride asks
  // again even when its owner is the same country.
  () =>
    mark.value?.kind === 'flag'
      ? `${mark.value.code}:${orbital.value?.noradId ?? ''}`
      : null,
  async (key) => {
    if (!key || flagsReady.value) return;
    const ready = await preloadOwnerFlags();
    flagsReady.value = ready;
    flagsFailed.value = !ready;
  },
  { immediate: true },
);
const shownMark = computed(() =>
  shownOwnerMark(mark.value, {
    ready: flagsReady.value,
    failed: flagsFailed.value,
  }),
);

// NORAD · COSPAR · TLE epoch, and the two element lines on request.
const identParts = computed(() => {
  const o = orbital.value;
  if (!o) return [];
  const parts = [];
  if (o.noradId !== null && o.noradId !== undefined && o.noradId !== '')
    parts.push(t('NORAD {id}', { id: String(o.noradId) }));
  if (o.cosparId) parts.push(o.cosparId);
  const epoch = formatTleEpochUtc(o.tle?.epochMs);
  if (epoch) parts.push(t('EPOCH {time}', { time: epoch }));
  const age = tleAgeParts(o.tleAgeMs);
  if (age?.unit === 'under-hour') parts.push(t('<1 H OLD'));
  else if (age?.unit === 'hours')
    parts.push(t('{value} H OLD', { value: formatNumber(age.value) }));
  else if (age?.unit === 'days')
    parts.push(t('{value} D OLD', { value: formatNumber(age.value) }));
  return parts;
});
const identText = computed(() => identParts.value.join(' · '));
const tleText = computed(() => {
  const tle = orbital.value?.tle;
  return tle?.line1 && tle?.line2 ? `${tle.line1}\n${tle.line2}` : '';
});
const tleOpen = ref(false);
// Another satellite starts with its element set folded.
watch(
  () => orbital.value?.noradId ?? null,
  () => {
    tleOpen.value = false;
  },
);

// The off-nadir tilt; an untilted view shows no readout or reset.
const look = computed(() => orbital.value?.look || { offset: false });
// A ground focus names its target in a polite live region; the angle,
// which changes every update, is left out of it.
const focusText = computed(() => {
  const label = look.value.focus?.label;
  return label ? t('FOCUS · {name}', { name: label }) : '';
});

const transition = computed(() => orbital.value?.transition || {});
const lensStyle = computed(() => {
  const blurPx = transition.value.blurPx;
  return {
    '--cockpit-orbital-blur': `${finite(blurPx) && blurPx > 0 ? blurPx.toFixed(2) : 0}px`,
  };
});
</script>

<template>
  <section id="cockpit-orbital" class="cockpit-orbital" :class="{ 'cockpit-orbital-focusing': transition.active }" :style="lensStyle" :aria-label="t('Orbital view')" :hidden="!orbital">
    <template v-if="orbital">
      <div class="cockpit-orbital-lens" aria-hidden="true"></div>
      <div class="cockpit-orbital-reticle" :class="{ 'cockpit-orbital-reticle-lock': transition.lockTick }" aria-hidden="true">
        <span class="cockpit-orbital-bracket cockpit-orbital-bracket-tl"></span>
        <span class="cockpit-orbital-bracket cockpit-orbital-bracket-tr"></span>
        <span class="cockpit-orbital-bracket cockpit-orbital-bracket-bl"></span>
        <span class="cockpit-orbital-bracket cockpit-orbital-bracket-br"></span>
        <span class="cockpit-orbital-cross"></span>
        <!-- North on the frame: at the top while north-up, turned with the ground track while track-up. -->
        <span class="cockpit-orbital-north-pointer" :style="northPointerStyle">
          <span class="cockpit-orbital-north-tick"></span>
          <span v-if="trackUp" class="cockpit-orbital-north-letter" :style="northLetterStyle">{{ t('N') }}</span>
        </span>
      </div>
      <!-- The imaging sensor's swath, to scale across the view. -->
      <div v-if="sensorStripStyle" class="cockpit-orbital-sensor-strip" :style="sensorStripStyle" aria-hidden="true"></div>
      <!-- Under the vision selector: where the ground track is. -->
      <p v-if="placeText" id="cockpit-orbital-over" class="cockpit-orbital-over"><span>{{ t('CURRENTLY OVER') }}</span> <strong>{{ placeText }}</strong></p>
      <div class="cockpit-orbital-readout">
        <p class="cockpit-orbital-kicker">{{ look.offset ? t('ORBITAL VIEW · OFF-NADIR') : t('ORBITAL VIEW · NADIR') }}</p>
        <div class="cockpit-orbital-title">
          <span v-if="shownMark?.kind === 'flag'" class="cockpit-orbital-flag" role="img" :aria-label="shownMark.label" :title="shownMark.label" :style="shownMark.style"></span>
          <span v-else-if="shownMark?.kind === 'badge'" class="cockpit-orbital-owner-badge" :title="shownMark.title">{{ shownMark.label }}</span>
          <p class="cockpit-orbital-name">{{ orbital.name }}</p>
        </div>
        <p v-if="orbital.operator" class="cockpit-orbital-operator">{{ orbital.operator }}</p>
        <p v-if="orbital.classLabel" class="cockpit-orbital-class">{{ orbital.classLabel }}</p>
        <div v-if="identText" class="cockpit-orbital-ident">
          <!-- Wraps between parts, never inside a date. -->
          <span class="cockpit-orbital-ident-text"><template v-for="(part, index) in identParts" :key="index"><template v-if="index"> · </template><span class="cockpit-orbital-ident-part">{{ part }}</span></template></span>
          <button v-if="tleText" id="cockpit-orbital-tle-toggle" type="button" class="cockpit-orbital-tle-toggle" :aria-expanded="String(tleOpen)" aria-controls="cockpit-orbital-tle" :aria-label="tleOpen ? t('Hide the two-line element set') : t('Show the two-line element set')" :title="tleOpen ? t('Hide the two-line element set') : t('Show the two-line element set')" @click="tleOpen = !tleOpen">{{ t('TLE') }}</button>
        </div>
        <pre v-if="tleText" v-show="tleOpen" id="cockpit-orbital-tle" class="cockpit-orbital-tle" :aria-label="t('Two-line element set')">{{ tleText }}</pre>
        <dl class="cockpit-orbital-data">
          <div class="cockpit-orbital-datum">
            <dt>{{ t('ALTITUDE') }}</dt>
            <dd class="cockpit-orbital-altitude">{{ altitudeText }}</dd>
          </div>
          <div v-if="velocityText" class="cockpit-orbital-datum">
            <dt>{{ t('ORBITAL VELOCITY') }}</dt>
            <dd class="cockpit-orbital-velocity">{{ velocityText }}</dd>
          </div>
          <div class="cockpit-orbital-datum">
            <dt>{{ t('SUB-SATELLITE POINT') }}</dt>
            <dd class="cockpit-orbital-subpoint">{{ subPointText }}</dd>
          </div>
        </dl>
        <p class="cockpit-orbital-north">{{ trackUp ? t('TRACK UP') : t('NORTH UP') }}</p>
        <!-- Shown only while the view is tilted off nadir: where it looks and the way back. -->
        <div v-if="look.offset" class="cockpit-orbital-look">
          <span id="cockpit-orbital-look-readout" class="cockpit-orbital-look-readout" :aria-live="look.focus ? 'off' : 'polite'">{{ look.readout }}</span>
          <button id="cockpit-orbital-nadir" ref="nadirButton" type="button" class="cockpit-orbital-nadir" :aria-label="t('Return the view to nadir')" :title="t('Return to nadir (Home or 0)')" aria-keyshortcuts="Home 0">{{ t('NADIR') }}</button>
        </div>
        <p id="cockpit-orbital-focus" class="cockpit-orbital-focus" aria-live="polite">{{ focusText }}</p>
      </div>
      <div class="cockpit-orbital-optics">
        <button id="cockpit-orbital-zoom-out" ref="zoomOutButton" type="button" class="cockpit-orbital-zoom-button" :disabled="atWidest" :aria-label="t('Zoom out')" :title="t('Zoom out (−)')" aria-keyshortcuts="- _">−</button>
        <span class="cockpit-orbital-zoom" aria-live="polite">{{ zoomText }}</span>
        <button id="cockpit-orbital-zoom-in" ref="zoomInButton" type="button" class="cockpit-orbital-zoom-button" :disabled="atTightest" :aria-label="t('Zoom in')" :title="t('Zoom in (+)')" aria-keyshortcuts="+ =">+</button>
        <span v-if="swathText" class="cockpit-orbital-swath">{{ swathText }}</span>
        <span v-if="sensorText" class="cockpit-orbital-swath cockpit-orbital-sensor-swath">{{ sensorText }}</span>
        <button v-if="sensorStepShown" id="cockpit-orbital-sensor" ref="sensorButton" type="button" class="cockpit-orbital-sensor-step" :aria-label="t('Zoom to the imaging sensor swath')" :title="t('Zoom to the imaging sensor swath')">{{ t('SENSOR') }}</button>
      </div>
    </template>
  </section>
</template>
