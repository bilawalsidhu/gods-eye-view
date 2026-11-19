<script setup>
import { storeToRefs } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { msg, t } from '../../i18n/index.js';
import { FIRST_RUN_LINKS, environmentalLabel } from '../../firstRunCopy.js';
import { useFirstRunStore } from '../stores/firstRun.js';
import { useStoriesStore } from '../stores/stories.js';

// The launcher initFirstRunExperience presents, and the controls it connects.
const { launcher, controls } = storeToRefs(useFirstRunStore());
// The card stays hidden until it is initialized; these show in the markup.
const ENVIRONMENTAL_SUB = msg(
  'Live earthquakes and active fires, from USGS and NASA',
);

// Where the visitor starts: a tile selects it, ENTER GOD MODE runs it. A clean
// globe unless they pick a mission.
const start = ref('explore');
const settling = ref(false);
function selectStart(choice) {
  if (settling.value || launcher.value?.busy === 'true' || launcher.value?.closing) return;
  start.value = choice;
}

// Three short steps instead of one dense card: mode, where to start, then the
// three things worth knowing. Back and Next move between them; Skip closes.
const STEPS = 3;
const step = ref(1);
const direction = ref('forward');
function go(next, event) {
  if (event?.detail > 1) return;
  if (settling.value || launcher.value?.busy === 'true' || launcher.value?.closing) return;
  settling.value = true;
  direction.value = next > step.value ? 'forward' : 'back';
  step.value = Math.min(STEPS, Math.max(1, next));
}
// A press belongs to the step it began on: one begun while the steps were
// changing (and released after) runs nothing. Keyboard clicks (detail 0)
// have no press.
let pressedOn = null;
function onPrimaryDown() {
  pressedOn = settling.value ? null : step.value;
}
// A quick second click still moves to the next step, so the button never
// looks dead; only the launch itself takes a single click, so a double click
// that began on NEXT never confirms the start it lands on.
function onPrimary(event) {
  if (settling.value) return;
  const pressed = pressedOn;
  pressedOn = null;
  if (event.detail >= 1 && pressed !== step.value) return;
  if (step.value < STEPS) go(step.value + 1);
  else if (event.detail <= 1) controls.value?.choose(start.value);
}
// GEV Stories opens in place: the card closes as Skip would, then Explore
// takes the globe. The Stories announcement stays hidden while Stories loads,
// so it does not flash up between the card closing and Explore opening; it is
// still not marked seen. The card is left out where Stories is not offered.
const stories = useStoriesStore();
let openingStories = false;
function openStories(event) {
  if (event?.detail > 1) return;
  if (settling.value || launcher.value?.busy === 'true' || launcher.value?.closing) return;
  if (!stories.available || !stories.controller) return;
  if (openingStories) return;
  const body = globalThis.document?.body;
  // Stories says at once whether it opens (it refuses while another mode
  // holds the globe): only then does the card close, so a refusal never
  // leaves nothing on screen.
  const opening = stories.controller.open();
  if (opening === false) return;
  openingStories = true;
  body?.classList.add('first-run-opening-stories');
  controls.value?.dismiss();
  Promise.resolve(opening)
    .catch(() => {})
    .finally(() => {
      openingStories = false;
      body?.classList.remove('first-run-opening-stories');
    });
}
function onPrimaryKeydown(event) {
  if (event.repeat) event.preventDefault();
}
function beforeStepEnter() {
  globalThis.document?.querySelector('#first-run-launcher .first-run-choices')
    ?.scrollTo({ top: 0, behavior: 'instant' });
}
function afterStepEnter() {
  settling.value = false;
  controls.value?.refreshLayout();
}
// Keyboard users stay on the main action as the steps change.
watch(step, async () => {
  await nextTick();
  if (!launcher.value?.visible || launcher.value?.closing) return;
  globalThis.document
    ?.querySelector('#first-run-launcher [data-first-run-primary]')
    ?.focus?.({ preventScroll: true });
});
const TITLES = [
  msg('Welcome to God\'s Eye View'),
  msg('Where do you want to start?'),
  msg('Three things to know'),
];
const LEADS = [
  msg('It feels like a forbidden cockpit—then you realize the sources are public and the data is real.'),
  msg('Pick one to begin with. You can change everything later.'),
  msg('That is all you need to get going.'),
];

// A callout opens from the chip's start edge unless that would run past the
// scrolling list, which clips it; then it opens from the end edge, and where
// neither side has room it narrows (and wraps) to the roomier side.
function alignCallout(event) {
  const chip = event.target?.closest?.('[data-callout]');
  const list = chip?.closest('.first-run-choices');
  if (!chip || !list) return;
  delete chip.dataset.calloutAlign;
  chip.style.removeProperty('--first-run-callout-max');
  const after = globalThis.getComputedStyle?.(chip, '::after');
  const width = parseFloat(after?.width);
  if (!Number.isFinite(width)) return;
  const box = chip.getBoundingClientRect();
  const bounds = list.getBoundingClientRect();
  const inset = parseFloat(after.insetInlineStart) || 0;
  const extra = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, key) => sum + (parseFloat(after[key]) || 0), 0);
  const size = after.boxSizing === 'border-box' ? width : width + extra;
  const rtl = globalThis.getComputedStyle?.(chip).direction === 'rtl';
  const roomStart = rtl ? box.right - inset - bounds.left : bounds.right - box.left - inset;
  const roomEnd = rtl ? bounds.right - box.left - inset : box.right - inset - bounds.left;
  if (size <= roomStart) return;
  if (roomEnd > roomStart) chip.dataset.calloutAlign = 'end';
  if (size > Math.max(roomStart, roomEnd)) {
    chip.style.setProperty('--first-run-callout-max', `${Math.floor(Math.max(roomStart, roomEnd))}px`);
  }
}

// A refused save puts the box back where the stored preference is.
function onSuppress(event) {
  const box = event.currentTarget;
  if (controls.value?.suppress(box.checked) === false) box.checked = !box.checked;
}
</script>

<template>
  <!-- Explicit first choice on a fresh session. Live feeds are not auto-enabled
       until the visitor asks; shared links skip this surface entirely. It returns
       every session until "Don't show this again" is ticked — see
       src/firstRunExperience.js for the full show policy. -->
  <!-- Tints the globe behind the card; click-through, so the card stays non-modal. -->
  <div v-if="!launcher?.removed && launcher?.shown" class="first-run-backdrop" :class="{ visible: launcher?.visible }" aria-hidden="true"></div>
  <aside v-if="!launcher?.removed" id="first-run-launcher" role="dialog" aria-labelledby="first-run-title" aria-describedby="first-run-description" :class="{ visible: launcher?.visible }" :hidden="!launcher?.shown" :aria-hidden="launcher?.closing ? 'true' : undefined" :aria-busy="launcher?.busy ?? undefined" :data-state="launcher?.state ?? undefined">
    <div class="first-run-scanline" aria-hidden="true"></div>
    <header class="first-run-header">
      <span class="first-run-kicker">{{ t('MISSION CONTROL · FIRST LAUNCH') }}</span>
      <ol role="img" class="first-run-dots" :aria-label="t('Step {step} of {total}', { step, total: STEPS })">
        <li v-for="n in STEPS" :key="n" :class="{ on: n === step, done: n < step }" aria-hidden="true"></li>
      </ol>
      <!-- A button, not just a hint: phones and tablets have no ESC key. It
           closes exactly as ESC does, for this session only. Touch screens
           see SKIP; a keyboard sees SKIP · ESC (first-run.css). -->
      <button type="button" class="first-run-dismiss" data-first-run-dismiss @click="controls?.dismiss()">
        <span class="first-run-dismiss-key">{{ t('SKIP · ESC') }}</span>
        <span class="first-run-dismiss-touch">{{ t('SKIP') }}</span>
      </button>
    </header>
    <h2 id="first-run-title">{{ t(TITLES[step - 1]) }}</h2>
    <p class="first-run-step-announcement" role="status" aria-live="polite" aria-atomic="true">{{ t(TITLES[step - 1]) }}</p>
    <p id="first-run-description">{{ t(LEADS[step - 1]) }}</p>
    <div class="first-run-choices ui-scroll" :data-scrollable="launcher?.scrollable ?? undefined">
     <Transition :name="`first-run-step-${direction}`" mode="out-in" @before-enter="beforeStepEnter" @after-enter="afterStepEnter">
      <div v-if="step === 1" key="1" class="first-run-step">
      <section class="first-run-section" aria-labelledby="first-run-mode-heading">
        <h3 id="first-run-mode-heading" class="first-run-section-title">{{ t('Choose your mode') }}</h3>
        <div class="first-run-modes" role="list" aria-labelledby="first-run-mode-heading">
          <div class="first-run-mode" role="listitem" data-first-run-mode="god">
            <div class="first-run-preview first-run-preview--god" aria-hidden="true"><i><svg class="first-run-globe" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1"><circle cx="32" cy="32" r="26" /><path d="M6 32h52M10 19h44M10 45h44" /><g class="first-run-meridians"><ellipse cx="32" cy="32" rx="26" ry="26" style="--m: 0" /><ellipse cx="32" cy="32" rx="26" ry="26" style="--m: 0.38" /><ellipse cx="32" cy="32" rx="26" ry="26" style="--m: 0.71" /><ellipse cx="32" cy="32" rx="26" ry="26" style="--m: 0.92" /></g></svg></i><svg class="first-run-callouts" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1"><path class="first-run-brackets" d="M8 18V8h10M102 8h10v10M112 102v10h-10M18 112H8v-10" /><circle class="first-run-orbit" cx="60" cy="60" r="34" /><g class="first-run-callout first-run-callout--a"><circle class="first-run-blip" cx="69" cy="50" r="1.6" /><circle class="first-run-ping" cx="69" cy="50" r="1.6" /><polyline class="first-run-leader" points="69,50 86,33 108,33" pathLength="1" /><path class="first-run-label" d="M88 29h18M88 37h11" /></g><g class="first-run-callout first-run-callout--b"><circle class="first-run-blip" cx="50" cy="71" r="1.6" /><circle class="first-run-ping" cx="50" cy="71" r="1.6" /><polyline class="first-run-leader" points="50,71 33,88 12,88" pathLength="1" /><path class="first-run-label" d="M14 84h18M14 92h11" /></g><g class="first-run-time"><line class="first-run-time-track" x1="26" y1="106" x2="94" y2="106" /><path class="first-run-time-ticks" d="M26 104v4 M34.5 105v2 M43 104v4 M51.5 105v2 M60 104v4 M68.5 105v2 M77 104v4 M85.5 105v2 M94 104v4" /><line class="first-run-time-played" x1="26" y1="106" x2="94" y2="106" /><g class="first-run-time-head"><line x1="26" y1="101" x2="26" y2="111" /><path d="M24 100h4l-2 2.5z" /></g></g></svg></div>
            <div class="first-run-mode-body">
              <p class="first-run-mode-title"><strong>{{ t('God') }}</strong> <span class="first-run-tag">{{ t('FUN') }}</span></p>
              <p class="first-run-mode-copy">{{ t('The spy-satellite keyhole: circular viewport, tactical HUD, cinematic camera. For exploring.') }}</p>
              <ul class="first-run-mode-points">
                <li>{{ t('Keyhole HUD') }}</li>
                <li>{{ t('Visual presets') }}</li>
              </ul>
            </div>
            <span class="first-run-radio" aria-hidden="true"></span>
          </div>
          <div class="first-run-mode" role="listitem" data-first-run-mode="analyst">
            <div class="first-run-preview first-run-preview--analyst" aria-hidden="true"><i></i></div>
            <div class="first-run-mode-body">
              <p class="first-run-mode-title"><strong>{{ t('Analyst') }}</strong> <span class="first-run-tag first-run-tag--soon">{{ t('COMING SOON') }}</span></p>
              <p class="first-run-mode-copy">{{ t('A cleaner, readable view where every value shows its source. For research and reporting.') }}</p>
            </div>
            <span class="first-run-radio" aria-hidden="true"></span>
          </div>
        </div>
      </section>

      </div>
      <div v-else-if="step === 2" key="2" class="first-run-step">
      <section class="first-run-section" aria-labelledby="first-run-start-heading">
        <h3 id="first-run-start-heading" class="first-run-section-title">{{ t('Start with') }}</h3>
        <div class="first-run-missions first-run-missions--tiles" role="group" aria-labelledby="first-run-start-heading">
          <button type="button" data-first-run-start="space-missions" :aria-pressed="String(start === 'space-missions')" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="selectStart('space-missions')">
            <span class="material-symbols-outlined" aria-hidden="true">rocket_launch</span>
            <span><strong>{{ t('SPACE MISSIONS') }}</strong><small>{{ t('Launches, spacecraft and orbital context') }}</small></span>
          </button>
          <button type="button" data-first-run-start="environmental" :aria-pressed="String(start === 'environmental')" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="selectStart('environmental')">
            <span class="material-symbols-outlined" aria-hidden="true">local_fire_department</span>
            <!-- The title is ENVIRONMENTAL_LABEL_CHOICE's label once initialized. -->
            <!-- Subcopy names BOTH feeds this tile turns on, because the launcher
                 optimizes for the fully configured experience (owner ruling,
                 2026-08-23) — see the mission table in src/firstRunExperience.js. -->
            <span><strong data-first-run-environmental-title>{{ launcher?.environmentalTitle ?? environmentalLabel().title }}</strong><small>{{ launcher?.environmentalSub ?? t(ENVIRONMENTAL_SUB) }}</small></span>
          </button>
          <button type="button" data-first-run-start="explore" :aria-pressed="String(start === 'explore')" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="selectStart('explore')">
            <span class="material-symbols-outlined" aria-hidden="true">public</span>
            <span><strong>{{ t('EXPLORE MANUALLY') }}</strong><small>{{ t('Begin with a clean globe') }}</small></span>
          </button>
        </div>
      </section>

      </div>
      <div v-else key="3" class="first-run-step">
      <ul class="first-run-tips">
        <li class="first-run-tip first-run-tip--search">
          <span class="first-run-tip-art" aria-hidden="true"><span class="material-symbols-outlined">search</span><i class="first-run-tip-caret"></i></span>
          <strong>{{ t('Search places') }}</strong>
          <small>{{ t('Type a place into the search bar.') }}</small>
        </li>
        <li class="first-run-tip first-run-tip--layers">
          <span class="first-run-tip-art" aria-hidden="true"><span class="material-symbols-outlined">layers</span><i class="first-run-tip-dot"></i></span>
          <strong>{{ t('Turn on layers') }}</strong>
          <small>{{ t('Turn layers on to see flights, ships, cameras, weather and more.') }}</small>
        </li>
        <li class="first-run-tip first-run-tip--context">
          <span class="first-run-tip-art" aria-hidden="true"><span class="material-symbols-outlined">my_location</span><i class="first-run-tip-ring"></i></span>
          <strong>{{ t('Click anything') }}</strong>
          <small>{{ t('Select a map item to see its details.') }}</small>
        </li>
      </ul>
      <section class="first-run-section" aria-labelledby="first-run-deeper-heading">
        <h3 id="first-run-deeper-heading" class="first-run-section-title">{{ t('Go deeper') }}</h3>
        <div v-if="stories.available" class="first-run-link-card first-run-stories">
          <div class="first-run-preview first-run-preview--stories" aria-hidden="true"><span class="material-symbols-outlined">movie</span></div>
          <div class="first-run-link-body">
            <p class="first-run-mode-title"><strong translate="no">GEV Stories</strong> <span class="first-run-tag">{{ t('NEW') }}</span></p>
            <p class="first-run-mode-copy">{{ t('Curated, interactive views of what is happening on Earth. Play one, take over the map whenever you like, then pick the story back up.') }}</p>
          </div>
          <button type="button" class="first-run-link-button" data-first-run-stories :aria-disabled="String(settling || launcher?.busy === 'true')" @click="openStories">{{ t('BROWSE STORIES') }}</button>
        </div>
      </section>


      <section class="first-run-section" aria-labelledby="first-run-more-heading">
        <h3 id="first-run-more-heading" class="first-run-section-title">{{ t('More from Halfpixel') }}</h3>
        <div class="first-run-link-row first-run-link-row--chips" @pointerover="alignCallout" @focusin="alignCallout">
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.youtube" :data-callout="t('Bilawal on YouTube')" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">▶</span>
            <span class="first-run-link-body"><strong translate="no">YouTube</strong></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.x" :data-callout="t('Bilawal on {site}', { site: 'X' })" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">X</span>
            <span class="first-run-link-body"><strong translate="no">X</strong></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.instagram" :data-callout="t('Bilawal on {site}', { site: 'Instagram' })" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">IG</span>
            <span class="first-run-link-body"><strong translate="no">Instagram</strong></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.linkedin" :data-callout="t('Bilawal on {site}', { site: 'LinkedIn' })" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">in</span>
            <span class="first-run-link-body"><strong translate="no">LinkedIn</strong></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.website" :data-callout="t('Bilawal\'s website')" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">B</span>
            <span class="first-run-link-body"><strong translate="no">bilawal.ai</strong></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.halfpixel" :data-callout="t('The studio behind GEV')" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">HP</span>
            <span class="first-run-link-body"><strong translate="no">halfpixel.ai</strong></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.source" target="_blank" rel="noopener noreferrer" :data-callout="t('Open source. Self-host, fork, add a layer.')">
            <span class="first-run-link-badge" aria-hidden="true">&lt;/&gt;</span>
            <span class="first-run-link-body"><strong translate="no">GitHub</strong></span>
          </a>
        </div>
      </section>
      </div>
     </Transition>
    </div>
    <div class="first-run-footer">
      <label class="first-run-suppress">
        <input type="checkbox" data-first-run-suppress @change="onSuppress" />
        <span>{{ t('Don\'t show this again') }}</span>
      </label>
      <!-- The status line: empty until a mission reports progress or an
           error. It sits in the footer row, so it never changes the card's
           height. -->
      <p class="first-run-note" data-first-run-status role="status" aria-live="polite">{{ launcher?.status ?? '' }}</p>
      <!-- The card's main action: God mode, starting where the selected tile
           says (a clean globe by default). -->
      <button v-if="step > 1" type="button" class="first-run-back" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="go(step - 1, $event)">{{ t('BACK') }}</button>
      <button type="button" class="first-run-enter" :data-first-run-choice="step === STEPS ? start : undefined" :data-first-run-next="step < STEPS ? '' : undefined" data-first-run-primary aria-describedby="first-run-title first-run-description" @pointerdown="onPrimaryDown" @keydown.enter="onPrimaryKeydown" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="onPrimary">
        {{ step < STEPS ? t('NEXT') : t('ENTER GOD MODE') }} <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
      </button>
    </div>

  </aside>
</template>
