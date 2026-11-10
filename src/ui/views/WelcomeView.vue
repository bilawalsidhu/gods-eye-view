<script setup>
import { storeToRefs } from 'pinia';
import { msg, t } from '../../i18n/index.js';
import {
  FIRST_RUN_TIP,
  environmentalLabel,
} from '../../firstRunCopy.js';
import { useFirstRunStore } from '../stores/firstRun.js';

// The launcher initFirstRunExperience presents, and the controls it connects.
const { launcher, controls } = storeToRefs(useFirstRunStore());
// The card stays hidden until it is initialized; these show in the markup.
const DESCRIPTION = msg(
  'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
);
const ENVIRONMENTAL_SUB = msg(
  'Live earthquakes and active fires, from USGS and NASA',
);

// A refused save puts the box back where the stored preference is.
function onSuppress(event) {
  const box = event.currentTarget;
  if (controls.value?.suppress(box.checked) === false) box.checked = !box.checked;
}
</script>

<template>
  <!-- Explicit mission choice on a fresh session. Live feeds are not auto-enabled
       until the visitor asks; shared links skip this surface entirely. It returns
       every session until "Don't show this again" is ticked — see
       src/firstRunExperience.js for the full show policy. -->
  <aside v-if="!launcher?.removed" id="first-run-launcher" role="dialog" aria-labelledby="first-run-title" aria-describedby="first-run-description" :class="{ visible: launcher?.visible }" :hidden="!launcher?.shown" :aria-hidden="launcher?.closing ? 'true' : undefined" :aria-busy="launcher?.busy ?? undefined" :data-state="launcher?.state ?? undefined">
    <div class="first-run-scanline" aria-hidden="true"></div>
    <header class="first-run-header">
      <span class="first-run-kicker">{{ t('MISSION CONTROL · FIRST LAUNCH') }}</span>
    </header>
    <h2 id="first-run-title">{{ t('Choose your first view') }}</h2>
    <!-- The card's one persuasive line, owner-authored and VERBATIM (2026-08-23)
         — including the unspaced em dash. The arc it has to carry: this looks
         like something you should not have access to → the sources are all
         public → the data is real. Tile subcopy stays purely functional. -->
    <p id="first-run-description">{{ launcher?.description ?? DESCRIPTION }}</p>
    <div class="first-run-choices ui-scroll" :data-scrollable="launcher?.scrollable ?? undefined">
      <button type="button" data-first-run-choice="contacts" :aria-disabled="launcher?.busy ?? undefined" @click="controls?.choose('contacts')">
        <span class="material-symbols-outlined" aria-hidden="true">radar</span>
        <span><strong>{{ t('LIVE CONTACTS') }}</strong><small>{{ t('Aircraft, vessels and nearby intelligence') }}</small></span>
        <span class="material-symbols-outlined first-run-arrow" aria-hidden="true">arrow_forward</span>
      </button>
      <button type="button" data-first-run-choice="space-missions" :aria-disabled="launcher?.busy ?? undefined" @click="controls?.choose('space-missions')">
        <span class="material-symbols-outlined" aria-hidden="true">rocket_launch</span>
        <span><strong>{{ t('SPACE MISSIONS') }}</strong><small>{{ t('Launches, spacecraft and orbital context') }}</small></span>
        <span class="material-symbols-outlined first-run-arrow" aria-hidden="true">arrow_forward</span>
      </button>
      <button type="button" data-first-run-choice="environmental" :aria-disabled="launcher?.busy ?? undefined" @click="controls?.choose('environmental')">
        <span class="material-symbols-outlined" aria-hidden="true">local_fire_department</span>
        <!-- The title is ENVIRONMENTAL_LABEL_CHOICE's label once initialized. -->
        <!-- Subcopy names BOTH feeds this tile turns on, because the launcher
             optimizes for the fully configured experience (owner ruling,
             2026-08-23) — see the mission table in src/firstRunExperience.js. -->
        <span><strong data-first-run-environmental-title>{{ launcher?.environmentalTitle ?? environmentalLabel().title }}</strong><small>{{ launcher?.environmentalSub ?? ENVIRONMENTAL_SUB }}</small></span>
        <span class="material-symbols-outlined first-run-arrow" aria-hidden="true">arrow_forward</span>
      </button>
      <button type="button" class="first-run-explore" data-first-run-choice="explore" :aria-disabled="launcher?.busy ?? undefined" @click="controls?.choose('explore')">
        <span class="material-symbols-outlined" aria-hidden="true">public</span>
        <span><strong>{{ t('EXPLORE MANUALLY') }}</strong><small>{{ t('Begin with a clean globe') }}</small></span>
        <span class="material-symbols-outlined first-run-arrow" aria-hidden="true">arrow_forward</span>
      </button>
    </div>
    <div class="first-run-footer">
      <label class="first-run-suppress">
        <input type="checkbox" data-first-run-suppress @change="onSuppress" />
        <span>{{ t('Don\'t show this again') }}</span>
      </label>
      <!-- A button, not just a hint: phones and tablets have no ESC key. It
           closes exactly as ESC does, for this session only. Touch screens
           see DISMISS; a keyboard keeps the ESC hint (first-run.css). -->
      <button type="button" class="first-run-dismiss" data-first-run-dismiss @click="controls?.dismiss()">
        <span class="first-run-dismiss-key">{{ t('ESC to dismiss') }}</span>
        <span class="first-run-dismiss-touch">{{ t('DISMISS') }}</span>
      </button>
    </div>
    <!-- Kept out of the footer row: it swaps to mission progress and errors, and
         a live region that also holds layout makes the row jump as it speaks. -->
    <p class="first-run-note" data-first-run-status role="status" aria-live="polite">{{ launcher?.status ?? FIRST_RUN_TIP }}</p>
  </aside>
</template>
