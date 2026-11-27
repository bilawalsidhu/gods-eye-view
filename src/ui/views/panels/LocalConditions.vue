<script setup>
import { computed } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import { useCardWeather } from '../../useCardWeather.js';
import { weatherLook } from '../../spotConditions.js';
import { useNow } from '../../useNow.js';
import { clockLine, localClock } from '../../contextTime.js';
import { useEntityCardStore } from '../../stores/entityCard.js';

// Two rows of More details for something that stays put (a fire, a camera,
// a site): the weather there and its local time, "10:14 local, 16:14 UTC".
// Read the exact point so the clock uses the time zone at this spot.
const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
});

const store = useEntityCardStore();
const { weather, zone, pending } = useCardWeather(() => props, store);
const now = useNow(30_000);
const timeLabel = computed(() => localClock(zone.value, now.value) ? t('Local time') : t('Time'));
const time = computed(() => clockLine(zone.value, now.value, pending.value));
const weatherText = computed(() => {
  const here = weather.value;
  if (!Number.isFinite(here?.temperatureC)) return '';
  const words = [t('{n} °C', { n: formatNumber(Math.round(here.temperatureC)) }), t(weatherLook(here.weatherCode).label)];
  if (Number.isFinite(here.windKph)) words.push(t('wind {n} km/h', { n: formatNumber(Math.round(here.windKph)) }));
  return words.join(' · ');
});
</script>

<template>
  <div class="entity-card__fact">
    <dt>{{ timeLabel }}</dt>
    <dd>{{ time }}</dd>
  </div>
  <div v-if="weatherText" class="entity-card__fact">
    <dt>{{ t('Weather here') }}</dt>
    <dd>{{ weatherText }}</dd>
    <dd v-if="weather?.source === 'open-meteo'" class="entity-card__weather-credit-line">
      <a class="entity-card__weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener">{{ t('Weather data by Open-Meteo.com') }}</a>
    </dd>
  </div>
</template>
