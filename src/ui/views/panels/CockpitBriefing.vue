<script setup>
import { storeToRefs } from 'pinia';
import { computed, useTemplateRef } from 'vue';
import { t } from '../../../i18n/index.js';
import { createBriefState } from '../../cockpitBriefPages.js';
import { useCockpitStore } from '../../stores/cockpit.js';
import CockpitRoute from './CockpitRoute.vue';
import CockpitSignalList from './CockpitSignalList.vue';
import UiButton from '../../kit/UiButton.vue';

// The Cockpit briefing card. The Cockpit controller presents its pages,
// cycle toggle, regional news and local conditions; until it does, the card
// shows the state it starts in. The controls keep the controller's
// listeners. The route card and the signal rows render themselves.
const { presence, brief } = storeToRefs(useCockpitStore());
const initial = createBriefState();
const b = computed(() => brief.value ?? initial);
// The card's collapse, which its toggle and data-collapsed show.
const collapsed = computed(() => !!presence.value?.signalCollapsed);
// The card's page and the region's answer, as state hooks on the card.
const streamState = computed(() => ({
  'data-brief-page': brief.value?.pageId,
  'data-regional-status': brief.value?.regionalStatus || undefined,
  'data-collapsed': presence.value ? String(collapsed.value) : undefined,
}));
// A departed contact cannot stay selectable. Its row hands focus to the
// shown page's tab, which stays, so keyboard traversal carries on from the
// card's footer instead of the top of the page.
const stream = useTemplateRef('stream');
function leaveSignals() {
  const card = stream.value;
  (
    card?.querySelector(`[data-cockpit-brief-index="${b.value.pageIndex}"]`) ??
    card?.querySelector('#cockpit-signal-toggle')
  )?.focus({ preventScroll: true });
}
</script>

<template>
  <aside id="cockpit-signal-stream" class="cockpit-signal-window" :aria-label="t('Cockpit briefing carousel')" :hidden="!presence?.active" v-bind="streamState" ref="stream">
    <CockpitRoute />
    <header class="cockpit-card-header cockpit-signal-header">
      <div class="cockpit-brief-heading">
        <span id="cockpit-brief-kicker" class="cockpit-card-kicker cockpit-signal-kicker"><i aria-hidden="true"></i> {{ b.kicker }}</span>
        <strong id="cockpit-brief-subtitle">{{ b.subtitle }}</strong>
      </div>
      <nav class="cockpit-card-actions cockpit-brief-actions" :aria-label="t('Cockpit briefing controls')">
        <button id="cockpit-brief-previous" type="button" :aria-label="t('Previous briefing page')" :title="t('Previous briefing page')">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <span id="cockpit-brief-position" aria-live="polite">{{ b.position }}</span>
        <button id="cockpit-brief-next" type="button" :aria-label="t('Next briefing page')" :title="t('Next briefing page')">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
        <UiButton id="cockpit-brief-auto" :aria-label="b.autoLabel" :pressed="Boolean(b.autoRotate)" :title="b.autoHelp">{{ b.autoLabel }}</UiButton>
        <button id="cockpit-signal-toggle" type="button" :aria-label="collapsed ? t('Expand cockpit briefing panel') : t('Collapse cockpit briefing panel')" :aria-expanded="String(!collapsed)" :title="collapsed ? t('Expand briefing panel') : t('Collapse briefing panel')">
          <span class="material-symbols-outlined" aria-hidden="true">{{ collapsed ? 'right_panel_open' : 'right_panel_close' }}</span>
        </button>
      </nav>
    </header>
    <div class="cockpit-brief-stage">
      <section data-cockpit-brief-page="signals" :aria-label="t('Live signals')" :hidden="b.pageId !== 'signals'">
        <CockpitSignalList :leave="leaveSignals" />
      </section>
      <section data-cockpit-brief-page="news" :aria-label="t('Latest regional news')" :hidden="b.pageId !== 'news'">
        <div id="cockpit-news-status" class="cockpit-brief-status" :hidden="b.news.statusHidden" :data-state="b.news.state ?? undefined">{{ b.news.status }}</div>
        <ol id="cockpit-news-list" class="cockpit-news-list" aria-live="polite"><li v-for="article in b.news.articles" :key="article.key"><a :href="article.url" target="_blank" rel="noopener noreferrer"><strong>{{ article.title }}</strong><span>{{ article.meta }}</span></a></li></ol>
      </section>
      <section data-cockpit-brief-page="local" :aria-label="t('Location-based information')" :hidden="b.pageId !== 'local'">
        <div class="cockpit-local-place">
          <strong id="cockpit-local-place">{{ b.local.place }}</strong>
          <small id="cockpit-local-coordinates">{{ b.local.coordinates }}</small>
        </div>
        <div class="cockpit-local-grid">
          <div><span>{{ t('TEMP') }}</span><strong id="cockpit-local-temperature">{{ b.local.temperature }}</strong><small translate="no">OPEN-METEO</small></div>
          <div><span>{{ t('WIND') }}</span><strong id="cockpit-local-wind">{{ b.local.wind }}</strong><small id="cockpit-local-wind-direction">{{ b.local.windDirection }}</small></div>
          <div><span>{{ t('SKY') }}</span><strong id="cockpit-local-condition">{{ b.local.condition }}</strong><small id="cockpit-local-cloud">{{ b.local.cloud }}</small></div>
          <div><span>{{ t('PRECIP') }}</span><strong id="cockpit-local-precipitation">{{ b.local.precipitation }}</strong><small>{{ t('MM') }}</small></div>
        </div>
        <a class="cockpit-weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener">{{ t('Weather data by Open-Meteo.com') }}</a>
      </section>
    </div>
    <footer class="cockpit-signal-footer">
      <span id="cockpit-brief-source">{{ b.source }}</span>
      <nav class="cockpit-brief-tabs" :aria-label="t('Cockpit briefing pages')">
        <button type="button" data-cockpit-brief-index="0" :aria-label="t('Show Live Signals')" :aria-current="String(b.pageIndex === 0)">{{ t('SIG') }}</button>
        <button type="button" data-cockpit-brief-index="1" :aria-label="t('Show Regional News')" :aria-current="brief ? String(b.pageIndex === 1) : undefined">{{ t('NEWS') }}</button>
        <button type="button" data-cockpit-brief-index="2" :aria-label="t('Show Local Info')" :aria-current="brief ? String(b.pageIndex === 2) : undefined">{{ t('LOCAL') }}</button>
      </nav>
    </footer>
  </aside>
</template>
