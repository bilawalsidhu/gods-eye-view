<script setup>
import { storeToRefs } from 'pinia';
import { onBeforeUpdate, onUpdated, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { useContextStore } from '../../stores/context.js';
import AwarenessNames from './AwarenessNames.vue';

// The Contacts panel inside Context. The Contacts layer publishes its view
// (standby, results or empty); until it does, the panel shows its initial
// markup. Buttons call the layer's navigation as the person's own.
const { awareness: view, awarenessLayer: layer } = storeToRefs(useContextStore());
const user = { origin: 'user' };
const root = ref(null);

// A live repaint keeps focus on the same control by identity: browsers drop
// focus from a node Vue moves, removes or disables, so the control is found
// again by its key. When it is gone or disabled, focus continues at the note
// beyond the list rather than jumping to another contact.
const CONTINUATION = '[data-awareness-focus-continuation]';
const controlKey = (el) => {
  if (el?.matches?.(CONTINUATION)) return 'continuation';
  const { awarenessAction: action, awarenessLayer: layer, awarenessId: id } = el?.dataset ?? {};
  if (action) return `action:${action}`;
  return layer && id ? `target:${layer}:${id}` : null;
};
let focusedKey = null;
onBeforeUpdate(() => {
  const active = document.activeElement;
  focusedKey = root.value?.contains(active) ? controlKey(active) ?? 'continuation' : null;
});
onUpdated(() => {
  const key = focusedKey;
  focusedKey = null;
  const panel = root.value;
  // A disabled control may keep focus until the browser's next frame.
  const active = document.activeElement;
  if (!key || !panel || (panel.contains(active) && !active.disabled)) return;
  const retained = key === 'continuation' ? null : [...panel.querySelectorAll('button[data-awareness-action], button[data-awareness-id]')].find((control) => !control.disabled && controlKey(control) === key);
  (retained || panel.querySelector(CONTINUATION))?.focus({ preventScroll: true });
});
</script>

<template>
  <aside id="military-awareness-panel" class="ui-scroll" ref="root">
    <div v-if="!view" class="military-awareness-standby">
      <strong>{{ t('CONTACTS CONTEXT OFF') }}</strong>
      <span>{{ t('SELECT CONTACTS TO LOAD OBSERVED / MAPPED PROXIMITY') }}</span>
    </div>
    <div v-else-if="view.kind === 'standby'" class="military-awareness-standby">
      <strong>{{ view.title }}</strong>
      <span>{{ view.text }}</span>
    </div>
    <template v-else-if="view.kind === 'results'">
      <div class="military-awareness-subject">{{ view.subject }}</div>
      <AwarenessNames v-if="view.subjectNames" :names="view.subjectNames" />
      <div class="military-awareness-controls" role="group" :aria-label="view.navigation.label">
        <button type="button" data-awareness-action="previous" :title="view.navigation.previous.title" :disabled="view.navigation.previous.disabled" @click="layer?.navigatePrevious(user)">{{ view.navigation.previous.text }}</button>
        <button type="button" data-awareness-action="focus" @click="layer?.focusCurrent(user)">{{ view.navigation.focus.text }}</button>
        <button type="button" data-awareness-action="next" :title="view.navigation.next.title" :disabled="view.navigation.next.disabled" @click="layer?.navigateNext(user)">{{ view.navigation.next.text }}</button>
      </div>
      <section v-for="row in view.rows" :key="row.id" :class="['military-awareness-row', row.relationship]">
        <div><strong>{{ row.label }}</strong><b aria-live="polite">{{ row.count }}</b></div>
        <small>{{ row.detail }}</small>
        <ul v-if="row.nearest.length">
          <li v-for="item in row.nearest" :key="item.key">
            <button v-if="item.targetId" type="button" class="military-awareness-target" :data-awareness-layer="item.layer" :data-awareness-id="item.targetId" :aria-label="item.ariaLabel" @click="layer?.focusTarget(item.layer, item.targetId, user)">{{ item.label }} <span>{{ item.distance }}</span></button>
            <span v-else class="military-awareness-target unavailable" :aria-label="item.ariaLabel">{{ item.label }} <span>{{ item.distance }}</span></span>
            <AwarenessNames v-if="item.names" :names="item.names" />
          </li>
        </ul>
      </section>
      <p class="military-awareness-note" tabindex="-1" data-awareness-focus-continuation>{{ view.note }}</p>
    </template>
  </aside>
</template>
