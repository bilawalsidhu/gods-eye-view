<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useDataPacksStore } from '../../stores/dataPacks.js';

// The loaded data packs' attribution cards, one panel per set of data-pack
// presentations (src/scenes/dataPacks/presentation.js), inside the viewer's
// container.
const { panels } = storeToRefs(useDataPacksStore());

const panelStyle = {
  position: 'absolute',
  right: '10px',
  bottom: '70px',
  maxHeight: '40vh',
  overflowY: 'auto',
  zIndex: '30',
};
const cardStyle = {
  color: '#e3faff',
  background: '#08141eed',
  border: '1px solid #2491a8',
  padding: '8px',
  margin: '4px',
  maxWidth: '260px',
  font: '12px sans-serif',
};

// A removed player stops and lets go of its media, which a detached
// element would otherwise keep playing. This runs as Vue renders the
// removal, in the same task as the dispose that removed it.
const vPackMedia = {
  beforeUnmount(el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  },
};
</script>

<template>
  <Teleport v-for="panel in panels" :key="panel.key" :to="panel.container">
    <div data-director-packs="" :style="panelStyle"><section v-for="card in panel.cards" :key="card.key" :data-director-pack="card.id" :style="cardStyle"><div>{{ card.title }}</div><a v-if="card.url" :href="card.url" target="_blank" rel="noopener noreferrer" style="color: #6eeaff">{{ t('Source') }}</a><video v-if="card.media?.kind === 'video'" v-pack-media controls preload="none" style="width: 240px" :src="card.media.src"></video><audio v-else-if="card.media?.kind === 'audio'" v-pack-media controls preload="none" style="width: 240px" :src="card.media.src"></audio></section></div>
  </Teleport>
</template>
