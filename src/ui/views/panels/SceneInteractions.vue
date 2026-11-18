<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useSceneInteractionsStore } from '../../stores/sceneInteractions.js';

// The active shot's Scene actions panel, inside the viewer's container, as
// the scene interactions owner (src/scenes/interactions.js) presents it.
const { panel, controls } = storeToRefs(useSceneInteractionsStore());

const panelStyle = {
  position: 'absolute',
  left: '12px',
  bottom: '80px',
  zIndex: '31',
  maxWidth: '300px',
  maxHeight: '40vh',
  overflowY: 'auto',
  background: '#08141eed',
  color: '#e3faff',
  border: '1px solid #2491a8',
  padding: '10px',
  font: '13px sans-serif',
};
const buttonStyle = {
  display: 'block',
  background: '#10242e',
  color: '#e3faff',
  border: '1px solid #397080',
  borderRadius: '3px',
  padding: '6px 10px',
  cursor: 'pointer',
  font: 'inherit',
  margin: '6px 0',
  maxWidth: '100%',
  whiteSpace: 'normal',
};
// Each button keeps the panel it was rendered for, so one left over from an
// earlier panel cannot run the current actions.
const onClick = (owner, id) => () => controls.value?.dispatch(id, owner);
const outline = (id) => ({
  ...buttonStyle,
  outline: panel.value.outlined.includes(id) ? '2px solid #6eeaff' : '',
});
</script>

<template>
  <Teleport v-if="panel" :to="panel.container">
    <section :key="panel.id" data-director-interactions="" :aria-label="t('Scene actions')" :style="panelStyle"><strong>{{ t('Scene actions') }}</strong><p role="status">{{ panel.status }}</p><button v-for="item in panel.items" :key="item.id" type="button" :data-director-action="item.id" :disabled="panel.busy" :aria-pressed="String(panel.selected === item.id)" :style="outline(item.id)" :onClick="onClick(panel.owner, item.id)">{{ item.label }}</button><div data-director-action-card=""><template v-if="panel.card"><p>{{ panel.card.text }}</p><a v-if="panel.card.url" :href="panel.card.url" target="_blank" rel="noopener noreferrer" style="color: #6eeaff">{{ t('Source') }}</a></template></div></section>
  </Teleport>
</template>
