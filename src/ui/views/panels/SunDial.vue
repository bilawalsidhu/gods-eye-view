<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../../../i18n/index.js';

// A garden sundial for the middle of the view, drawn in 2.5D: a bronze
// plate seen from above at a slant, its hour lines laid out for the
// latitude, a gnomon whose edge points at the celestial pole, and the
// shadow that gnomon would really cast now, from the sun's true position
// (low-precision formulas, good to a fraction of a degree). At night the
// shadow goes and the plate dims.
const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
});

const now = ref(Date.now());
let timer = null;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 20_000);
});
onBeforeUnmount(() => clearInterval(timer));

const RAD = Math.PI / 180;

/** The sun's declination and the local hour angle (radians) at a moment. */
function sunNow(lon, when) {
  const d = (when - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const ecliptic = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const tilt = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(tilt) * Math.sin(ecliptic), Math.cos(ecliptic));
  const dec = Math.asin(Math.sin(tilt) * Math.sin(ecliptic));
  const sidereal = ((18.697374558 + 24.06570982441908 * d) % 24) * 15;
  let hour = (sidereal + lon) * RAD - ra;
  hour = Math.atan2(Math.sin(hour), Math.cos(hour));
  return { dec, hour };
}

/** Unit vector toward the sun in east-north-up for an hour angle and declination. */
function sunVector(phi, dec, hour) {
  return {
    e: -Math.cos(dec) * Math.sin(hour),
    n: Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(hour) * Math.sin(phi),
    u: Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(hour) * Math.cos(phi),
  };
}

// Drawing: ground x east, y toward the pole the gnomon faces, z up; the
// plate is seen from the south (or north) at a slant, so y shrinks and z
// rises on screen.
const W = 300;
const H = 196;
const CX = 150;
const CY = 104;
const R = 118;
const SLANT = 0.5;
const RISE = 0.62;
const THICK = 9;
// The plate is seen turned a little, from the side the shadow falls on, so
// the gnomon shows a face and never hides its own shadow.
const TURN = 34 * (Math.PI / 180);
let turn = -TURN;
const project = (x, y, z = 0) => {
  const rx = x * Math.cos(turn) - y * Math.sin(turn);
  const ry = x * Math.sin(turn) + y * Math.cos(turn);
  return { x: CX + rx, y: CY - ry * SLANT - z * RISE };
};
const pt = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

const dial = computed(() => {
  const phi = Math.max(-89, Math.min(89, props.lat)) * RAD;
  const south = props.lat < 0;
  // y on the plate points toward the gnomon's pole: north, or south below
  // the equator; east keeps its side by flipping x with it.
  const flip = south ? -1 : 1;
  const toPlate = (v) => ({ x: v.e * flip, y: v.n * flip, z: v.u });
  // The gnomon's edge points at the elevated pole.
  const pole = toPlate({ e: 0, n: Math.cos(phi) * flip, u: Math.abs(Math.sin(phi)) });
  // The style starts at the hour lines' centre, south of the plate's middle.
  const { dec, hour } = sunNow(props.lon, now.value);
  const sunEnu = sunVector(phi, dec, hour);
  const sun = toPlate(sunEnu);
  // Morning sun on the east throws the shadow west: look from the west.
  turn = sun.x > 0 ? TURN : -TURN;
  const origin = { x: 0, y: -R * 0.42 };
  const across = R * 0.62;
  const tip = { x: origin.x + pole.x * across, y: origin.y + pole.y * across, z: pole.z * across };
  const foot = { x: tip.x, y: tip.y, z: 0 };

  // Hour lines, 6 to 18 local solar time: where the style's shadow falls
  // with the sun on the equator at that hour.
  const rimHit = (dx, dy) => {
    // From the origin along (dx, dy) to the numeral ring (radius 0.84 R).
    const ring = R * 0.84;
    const b = origin.x * dx + origin.y * dy;
    const c = origin.x ** 2 + origin.y ** 2 - ring ** 2;
    const s = -b + Math.sqrt(b * b - c);
    return { x: origin.x + dx * s, y: origin.y + dy * s };
  };
  const hours = [];
  for (let h = 6; h <= 18; h++) {
    const s = toPlate(sunVector(phi, 0, (h - 12) * 15 * RAD));
    let dx;
    let dy;
    if (s.z > 0.02) {
      const k = pole.z / s.z;
      dx = pole.x - k * s.x;
      dy = pole.y - k * s.y;
    } else {
      dx = -s.x;
      dy = -s.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const end = rimHit(dx, dy);
    const label = rimHit(dx, dy);
    const out = R * 0.08;
    hours.push({
      h,
      from: project(origin.x, origin.y),
      to: project(end.x, end.y),
      label: project(label.x + dx * out, label.y + dy * out),
      major: h % 3 === 0,
    });
  }

  // The sun now, and the shadow of the gnomon's triangle on the plate.
  const elevation = Math.asin(Math.max(-1, Math.min(1, sunEnu.u))) / RAD;
  let shadow = null;
  if (sun.z > 0.03) {
    const k = tip.z / sun.z;
    let sx = tip.x - k * sun.x;
    let sy = tip.y - k * sun.y;
    // A low sun throws a long shadow; keep it on the plate.
    const reach = Math.hypot(sx - origin.x, sy - origin.y);
    const max = R * 1.05;
    if (reach > max) {
      sx = origin.x + ((sx - origin.x) * max) / reach;
      sy = origin.y + ((sy - origin.y) * max) / reach;
    }
    shadow = [project(origin.x, origin.y), project(foot.x, foot.y), project(sx, sy)].map(pt).join(' ');
  }
  // The sun lights the plate from its side: the bright spot of the bronze
  // sits toward the sun, nearer the middle the higher it stands.
  const azimuth = Math.atan2(sun.x, sun.y);
  const spread = 0.42 * Math.cos(Math.max(0, elevation) * RAD);
  const lit = project(Math.sin(azimuth) * R * spread, Math.cos(azimuth) * R * spread);
  const shine = {
    cx: `${(50 + ((lit.x - CX) / (2 * R)) * 100).toFixed(1)}%`,
    cy: `${(50 + ((lit.y - CY) / (2 * R * SLANT)) * 100).toFixed(1)}%`,
  };
  // The gnomon is a bronze plate a few units thick: its two faces at
  // x = ±w, drawn far face first, and the top edge between them. The face
  // turned toward the viewer is the +x one when the turn brings it round.
  const w = 2.4;
  const faceAt = (dx) =>
    [project(origin.x + dx, origin.y), project(foot.x + dx, foot.y), project(tip.x + dx, tip.y, tip.z)].map(pt).join(' ');
  const nearSide = Math.sin(turn) < 0 ? 1 : -1;
  const near = faceAt(nearSide * w);
  const far = faceAt(-nearSide * w);
  const top = [
    project(origin.x - w, origin.y),
    project(tip.x - w, tip.y, tip.z),
    project(tip.x + w, tip.y, tip.z),
    project(origin.x + w, origin.y),
  ]
    .map(pt)
    .join(' ');
  const nearLit = sun.z > 0 && Math.sign(sun.x || 1) === nearSide;

  const solar = new Date(now.value + (props.lon / 15) * 3_600_000);
  const clock = `${String(solar.getUTCHours()).padStart(2, '0')}:${String(solar.getUTCMinutes()).padStart(2, '0')}`;
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const bearing = (Math.atan2(sunEnu.e, sunEnu.n) / RAD + 360) % 360;

  // A small flat compass in the corner, turned to match the plate: each
  // cardinal's screen direction from the plate's projection (plate y points
  // to the gnomon's pole, x east, both flipped below the equator).
  const dir = (e, n) => {
    const a = project(0, 0);
    const b = project(e * flip * 40, n * flip * 40);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const cardinals = [
    { k: 'N', ...dir(0, 1) },
    { k: 'E', ...dir(1, 0) },
    { k: 'S', ...dir(0, -1) },
    { k: 'W', ...dir(-1, 0) },
  ];
  const sunDir = elevation > 0 ? dir(sunEnu.e, sunEnu.n) : null;

  return {
    cardinals,
    sunDir,
    hours,
    shadow,
    day: elevation > 0,
    elevation: Math.round(elevation),
    direction: t(compass[Math.round(bearing / 45) % 8]),
    shine,
    clock,
    gnomon: {
      near,
      far,
      top,
      nearLit,
      edge: [project(origin.x, origin.y), project(tip.x, tip.y, tip.z)],
    },
    poleLabel: project(0, R * 1.08),
    poleText: south ? 'S' : 'N',
  };
});

const ROMAN = ['VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const plateTop = { cx: CX, cy: CY, rx: R, ry: R * SLANT };
// A HUD tick ring round the plate's edge: every 5°, longer every 30°.
const ticks = Array.from({ length: 72 }, (_, i) => {
  const a = (i * 5 * Math.PI) / 180;
  const major = i % 6 === 0;
  const r1 = R * 0.99;
  const r0 = R * (major ? 0.94 : 0.965);
  return {
    i,
    major,
    x1: CX + Math.cos(a) * r0,
    y1: CY + Math.sin(a) * r0 * SLANT,
    x2: CX + Math.cos(a) * r1,
    y2: CY + Math.sin(a) * r1 * SLANT,
  };
});
const caption = computed(() =>
  dial.value.day
    ? t('Sundial · {time} solar · sun {deg}° {dir}', { time: dial.value.clock, deg: dial.value.elevation, dir: dial.value.direction })
    : t('Sundial · {time} solar · sun below the horizon', { time: dial.value.clock }),
);
</script>

<template>
  <figure class="sun-dial" :class="{ 'sun-dial--night': !dial.day }">
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="caption">
      <defs>
        <!-- Dark instrument glass, lit cyan toward the sun. -->
        <radialGradient id="sun-dial-plate" :cx="dial.shine.cx" :cy="dial.shine.cy" r="85%">
          <stop offset="0%" stop-color="#14394a" />
          <stop offset="40%" stop-color="#0b2230" />
          <stop offset="80%" stop-color="#06131b" />
          <stop offset="100%" stop-color="#040b10" />
        </radialGradient>
        <linearGradient id="sun-dial-rim" x1="0" x2="1">
          <stop offset="0%" stop-color="#03080c" />
          <stop offset="40%" stop-color="#0d2633" />
          <stop offset="60%" stop-color="#0a1d27" />
          <stop offset="100%" stop-color="#02060a" />
        </linearGradient>
        <radialGradient id="sun-dial-glow" :cx="dial.shine.cx" :cy="dial.shine.cy" r="55%">
          <stop offset="0%" stop-color="#36dcff" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#36dcff" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="sun-dial-gnomon-lit" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="#11607a" />
          <stop offset="100%" stop-color="#8af2ff" />
        </linearGradient>
        <linearGradient id="sun-dial-gnomon-dark" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="#06202b" />
          <stop offset="100%" stop-color="#145066" />
        </linearGradient>
        <filter id="sun-dial-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.7" />
        </filter>
        <filter id="sun-dial-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <filter id="sun-dial-line-glow" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <!-- Ground glow under the plate, then the plate's edge and its top. -->
      <ellipse :cx="plateTop.cx" :cy="plateTop.cy + THICK + 6" :rx="plateTop.rx * 1.02" :ry="plateTop.ry" fill="#000" opacity="0.55" filter="url(#sun-dial-soft)" />
      <path
        :d="`M ${CX - R} ${CY} A ${R} ${R * SLANT} 0 0 0 ${CX + R} ${CY} L ${CX + R} ${CY + THICK} A ${R} ${R * SLANT} 0 0 1 ${CX - R} ${CY + THICK} Z`"
        fill="url(#sun-dial-rim)"
        stroke="rgba(54, 220, 255, 0.22)"
        stroke-width="0.6"
      />
      <ellipse v-bind="plateTop" fill="url(#sun-dial-plate)" stroke="rgba(54, 220, 255, 0.55)" stroke-width="0.9" />
      <ellipse v-bind="plateTop" fill="url(#sun-dial-glow)" />
      <ellipse :cx="CX" :cy="CY" :rx="R * 0.88" :ry="R * 0.88 * SLANT" fill="none" stroke="rgba(54, 220, 255, 0.28)" stroke-width="0.5" />
      <ellipse :cx="CX" :cy="CY" :rx="R * 0.62" :ry="R * 0.62 * SLANT" fill="none" stroke="rgba(54, 220, 255, 0.14)" stroke-width="0.5" stroke-dasharray="2 3" />
      <g class="sun-dial__ticks">
        <line v-for="tick in ticks" :key="tick.i" :x1="tick.x1" :y1="tick.y1" :x2="tick.x2" :y2="tick.y2" :class="{ major: tick.major }" />
      </g>

      <!-- Hour lines and numerals. -->
      <g class="sun-dial__hours">
        <line
          v-for="line in dial.hours"
          :key="`l${line.h}`"
          :x1="line.from.x"
          :y1="line.from.y"
          :x2="line.to.x"
          :y2="line.to.y"
          :class="{ major: line.major }"
        />
        <text v-for="(line, i) in dial.hours" :key="`t${line.h}`" :x="line.label.x" :y="line.label.y + 2.6">{{ ROMAN[i] }}</text>
      </g>
      <text :x="dial.poleLabel.x" :y="dial.poleLabel.y + 3" class="sun-dial__pole">{{ t(dial.poleText) }}</text>

      <!-- The shadow, then the gnomon standing over it. -->
      <polygon v-if="dial.shadow" :points="dial.shadow" fill="#000" opacity="0.6" filter="url(#sun-dial-shadow)" />
      <polygon :points="dial.gnomon.far" fill="#03141b" />
      <polygon :points="dial.gnomon.top" :fill="dial.day ? '#7af0ff' : '#1d5a6b'" stroke="#03141b" stroke-width="0.4" />
      <polygon :points="dial.gnomon.near" :fill="dial.gnomon.nearLit ? 'url(#sun-dial-gnomon-lit)' : 'url(#sun-dial-gnomon-dark)'" stroke="rgba(54, 220, 255, 0.5)" stroke-width="0.5" />
      <line
        :x1="dial.gnomon.edge[0].x"
        :y1="dial.gnomon.edge[0].y"
        :x2="dial.gnomon.edge[1].x"
        :y2="dial.gnomon.edge[1].y"
        :stroke="dial.day ? '#b8f8ff' : '#2f7d92'"
        stroke-width="1"
        stroke-linecap="round"
        filter="url(#sun-dial-line-glow)"
      />

      <!-- Small compass, turned like the plate. -->
      <g class="sun-dial__compass" :transform="`translate(${W - 30} 30)`">
        <circle r="15" class="sun-dial__compass-ring" />
        <circle r="11" class="sun-dial__compass-inner" />
        <line
          v-for="c in dial.cardinals"
          :key="`t${c.k}`"
          :x1="c.x * 12"
          :y1="c.y * 12"
          :x2="c.x * 15"
          :y2="c.y * 15"
          class="sun-dial__compass-tick"
        />
        <path
          :d="`M ${dial.cardinals[0].x * 9.5} ${dial.cardinals[0].y * 9.5} L ${-dial.cardinals[0].y * 2.6} ${dial.cardinals[0].x * 2.6} L ${dial.cardinals[0].y * 2.6} ${-dial.cardinals[0].x * 2.6} Z`"
          class="sun-dial__compass-north"
        />
        <path
          :d="`M ${dial.cardinals[2].x * 9.5} ${dial.cardinals[2].y * 9.5} L ${-dial.cardinals[2].y * 2.6} ${dial.cardinals[2].x * 2.6} L ${dial.cardinals[2].y * 2.6} ${-dial.cardinals[2].x * 2.6} Z`"
          class="sun-dial__compass-south"
        />
        <circle v-if="dial.sunDir" :cx="dial.sunDir.x * 15" :cy="dial.sunDir.y * 15" r="2.4" class="sun-dial__compass-sun" />
        <text
          v-for="c in dial.cardinals"
          :key="c.k"
          :x="c.x * 20"
          :y="c.y * 20 + 2.3"
          :class="['sun-dial__compass-label', { north: c.k === 'N' }]"
        >{{ t(c.k) }}</text>
      </g>
    </svg>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>
