<script setup>
import { computed } from 'vue';
import { formatNumber, msg, t } from '../../../i18n/index.js';
import { roundHeadingDegrees } from '../../../data/headingDegrees.js';

const props = defineProps({
  /** Output of `aircraftTypeCardModel`. */
  model: { type: Object, required: true },
  /** Public-file URL resolver for the bundled type photos. */
  resolveAsset: { type: Function, default: (url) => url },
});

const FT_PER_M = 3.28084;
const KT_PER_MS = 1.944;
const DASH = '--';

const CLASS_LABELS = Object.freeze({
  light: msg('Light aircraft'),
  turboprop: msg('Turboprop'),
  bizjet: msg('Business jet'),
  airliner: msg('Airliner'),
  widebody: msg('Widebody airliner'),
  quadjet: msg('Four-engine airliner'),
  fastjet: msg('Fast jet'),
  helicopter: msg('Helicopter'),
  uav: msg('Unmanned aircraft'),
});

const ENGINE_LABELS = Object.freeze({
  jet: msg('Jet'),
  turbine: msg('Turbine'),
  piston: msg('Piston'),
});

const whole = (value) => formatNumber(Math.round(value), { useGrouping: true });
const orDash = (value, format) =>
  value === null || value === undefined ? DASH : format(value);

const military = computed(() => props.model.faction === 'military');
const photo = computed(() => props.model.photo);
const title = computed(
  () =>
    props.model.type?.name ??
    props.model.identity.typeCode ??
    t('Unidentified aircraft'),
);
const classLine = computed(() => {
  const faction = military.value ? t('Military') : t('Civil');
  const label = CLASS_LABELS[props.model.type?.class];
  return label ? `${faction} · ${t(label)}` : faction;
});
const footer = computed(() =>
  props.model.type
    ? t('Photo shows the aircraft type, not the tracked airframe.')
    : t('This aircraft type is not in the type library yet.'),
);

const specRows = computed(() => {
  const { specs, type } = props.model;
  const rows = [];
  if (type?.manufacturer)
    rows.push({ key: 'manufacturer', label: t('Manufacturer'), value: type.manufacturer, wide: true });
  if (!specs) return rows;
  if (specs.lengthM !== null)
    rows.push({ key: 'length', label: t('Length'), value: t('{value} m', { value: formatNumber(specs.lengthM) }) });
  if (specs.spanM !== null)
    rows.push({ key: 'span', label: t('Wingspan'), value: t('{value} m', { value: formatNumber(specs.spanM) }) });
  if (specs.engines !== null) {
    const engineType = specs.engineType;
    rows.push({
      key: 'engines',
      label: t('Engines'),
      value: engineType
        ? t('{count} × {type}', {
            count: specs.engines,
            type: ENGINE_LABELS[engineType] ? t(ENGINE_LABELS[engineType]) : engineType,
          })
        : String(specs.engines),
    });
  }
  if (specs.firstFlightYear !== null)
    rows.push({ key: 'firstFlight', label: t('First flight'), value: String(specs.firstFlightYear) });
  return rows;
});

const telemetryRows = computed(() => {
  const { telemetry, identity } = props.model;
  const rows = [
    { key: 'callsign', label: t('Callsign'), value: identity.callsign ?? identity.registration ?? DASH },
    { key: 'typeCode', label: t('Type code'), value: identity.typeCode ?? DASH },
    {
      key: 'altitude',
      label: t('Altitude'),
      value: orDash(telemetry.altitudeM, (m) => t('{value} ft', { value: whole(m * FT_PER_M) })),
    },
    {
      key: 'speed',
      label: t('Speed'),
      value: orDash(telemetry.speedMs, (ms) => t('{value} kt', { value: whole(ms * KT_PER_MS) })),
    },
    {
      key: 'heading',
      label: t('Heading'),
      value: orDash(telemetry.headingDeg, (deg) => t('{value}°', { value: roundHeadingDegrees(deg) })),
    },
    {
      key: 'position',
      label: t('Position'),
      value:
        telemetry.lat === null || telemetry.lon === null
          ? DASH
          : `${telemetry.lat.toFixed(3)}, ${telemetry.lon.toFixed(3)}`,
    },
  ];
  if (telemetry.origin || telemetry.destination)
    rows.push({
      key: 'route',
      label: t('Route'),
      value: `${telemetry.origin ?? DASH} → ${telemetry.destination ?? DASH}`,
      wide: true,
    });
  return rows;
});
</script>

<template>
  <section class="gev-type-card" :class="{ 'is-military': military }" data-aircraft-type-card>
    <header>
      <span><span class="dot"></span>{{ t('Selected aircraft') }}</span>
      <span>{{ model.identity.icao24?.toUpperCase() ?? '' }}</span>
    </header>
    <template v-if="photo">
      <div class="photo">
        <img :src="resolveAsset(photo.path)" :alt="model.type.name" loading="lazy" />
      </div>
      <div class="credit">
        {{ t('Photo') }}:
        <a v-if="photo.sourceUrl" :href="photo.sourceUrl" target="_blank" rel="noopener noreferrer">{{ photo.author ?? t('Unknown author') }}</a>
        <template v-else>{{ photo.author ?? t('Unknown author') }}</template>
        <template v-if="photo.licence">
          ·
          <a v-if="photo.licenceUrl" :href="photo.licenceUrl" target="_blank" rel="noopener noreferrer">{{ photo.licence }}</a>
          <template v-else>{{ photo.licence }}</template>
        </template>
        <template v-if="photo.cropped"> · {{ t('cropped') }}</template>
      </div>
    </template>
    <h2>{{ title }}</h2>
    <div class="cls">{{ classLine }}</div>
    <dl>
      <div v-for="row in specRows" :key="row.key" :class="{ wide: row.wide }">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
      <div v-for="row in telemetryRows" :key="row.key" :class="{ wide: row.wide }">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
    <footer>{{ footer }}</footer>
  </section>
</template>

<style scoped>
.gev-type-card {
  --acc: #00ffff;
  width: 320px;
  max-width: calc(100vw - 32px);
  color: #d8f6ff;
  font-size: 12px;
  background: rgba(4, 14, 22, 0.88);
  border: 1px solid color-mix(in srgb, var(--acc) 55%, transparent);
  box-shadow: 0 0 24px color-mix(in srgb, var(--acc) 25%, transparent), inset 0 0 30px color-mix(in srgb, var(--acc) 8%, transparent);
  clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
  backdrop-filter: blur(3px);
}
.gev-type-card.is-military { --acc: #ffb800; }
.gev-type-card header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--acc);
  border-bottom: 1px solid color-mix(in srgb, var(--acc) 35%, transparent);
}
.gev-type-card .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--acc);
  box-shadow: 0 0 8px var(--acc);
  animation: gev-type-card-blink 1.2s infinite;
}
@keyframes gev-type-card-blink { 50% { opacity: 0.25; } }
.gev-type-card .photo {
  position: relative;
  margin: 10px 12px 0;
  aspect-ratio: 16 / 8;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--acc) 40%, transparent);
}
.gev-type-card .photo img { display: block; width: 100%; height: 100%; object-fit: cover; filter: saturate(0.85) contrast(1.05); }
.gev-type-card .photo::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.18) 0 1px, transparent 1px 3px);
}
.gev-type-card .credit { margin: 3px 12px 0; font-size: 9px; line-height: 1.3; color: #7fa9b8; }
.gev-type-card .credit a { color: #99ffdd; }
.gev-type-card h2 {
  margin: 8px 12px 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #fff;
  text-shadow: 0 0 10px color-mix(in srgb, var(--acc) 60%, transparent);
}
.gev-type-card .cls { margin: 2px 12px 0; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--acc); }
.gev-type-card dl { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin: 10px 12px 12px; }
.gev-type-card dt { font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: #7fa9b8; }
.gev-type-card dd { margin: 0; font-size: 14px; color: #eaffff; }
.gev-type-card .wide { grid-column: 1 / -1; }
.gev-type-card footer {
  padding: 6px 12px;
  font-size: 9px;
  color: #5f8b99;
  border-top: 1px solid color-mix(in srgb, var(--acc) 25%, transparent);
}
</style>
