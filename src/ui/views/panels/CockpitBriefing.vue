<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { createBriefState } from '../../cockpitBriefPages.js';
import { useCockpitStore } from '../../stores/cockpit.js';
import CockpitRoute from './CockpitRoute.vue';

// The Cockpit briefing card. The Cockpit controller presents its pages,
// cycle toggle, regional news and local conditions; until it does, the card
// shows the state it starts in. The controls keep the controller's
// listeners. The route card renders itself; the signal list keeps its
// owner's bindings, so nothing here binds it.
const { brief } = storeToRefs(useCockpitStore());
const initial = createBriefState();
const b = computed(() => brief.value ?? initial);
// The card's page and the region's answer, as state hooks on the card.
const streamState = computed(() => ({
  'data-brief-page': brief.value?.pageId,
  'data-regional-status': brief.value?.regionalStatus || undefined,
}));
</script>

<template>
  <aside id="cockpit-signal-stream" class="cockpit-signal-window" aria-label="Cockpit briefing carousel" hidden data-i18n-aria-label v-bind="streamState">
    <CockpitRoute />
    <header class="cockpit-signal-header">
      <div class="cockpit-brief-heading">
        <span id="cockpit-brief-kicker" class="cockpit-signal-kicker"><i aria-hidden="true"></i> {{ b.kicker }}</span>
        <strong id="cockpit-brief-subtitle">{{ b.subtitle }}</strong>
      </div>
      <nav class="cockpit-brief-actions" aria-label="Cockpit briefing controls" data-i18n-aria-label>
        <button id="cockpit-brief-previous" type="button" aria-label="Previous briefing page" title="Previous briefing page" data-i18n-aria-label data-i18n-title>
          <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <span id="cockpit-brief-position" aria-live="polite">{{ b.position }}</span>
        <button id="cockpit-brief-next" type="button" aria-label="Next briefing page" title="Next briefing page" data-i18n-aria-label data-i18n-title>
          <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
        <button id="cockpit-brief-auto" type="button" :aria-label="b.autoLabel" :aria-pressed="String(b.autoRotate)" :title="b.autoHelp">{{ b.autoLabel }}</button>
        <button id="cockpit-signal-toggle" type="button" aria-label="Collapse cockpit briefing panel" aria-expanded="true" title="Collapse briefing panel" data-i18n-aria-label data-i18n-title>
          <span class="material-symbols-outlined" aria-hidden="true">right_panel_close</span>
        </button>
      </nav>
    </header>
    <div class="cockpit-brief-stage">
      <section data-cockpit-brief-page="signals" aria-label="Live signals" data-i18n-aria-label :hidden="b.pageId !== 'signals'">
        <ol id="cockpit-signal-list" class="cockpit-signal-list" aria-live="polite"></ol>
      </section>
      <section data-cockpit-brief-page="news" aria-label="Latest regional news" data-i18n-aria-label :hidden="b.pageId !== 'news'">
        <div id="cockpit-news-status" class="cockpit-brief-status" :hidden="b.news.statusHidden" :data-state="b.news.state ?? undefined">{{ b.news.status }}</div>
        <ol id="cockpit-news-list" class="cockpit-news-list" aria-live="polite"><li v-for="article in b.news.articles" :key="article.key"><a :href="article.url" target="_blank" rel="noopener noreferrer"><strong>{{ article.title }}</strong><span>{{ article.meta }}</span></a></li></ol>
      </section>
      <section data-cockpit-brief-page="local" aria-label="Location-based information" data-i18n-aria-label :hidden="b.pageId !== 'local'">
        <div class="cockpit-local-place">
          <strong id="cockpit-local-place">{{ b.local.place }}</strong>
          <small id="cockpit-local-coordinates">{{ b.local.coordinates }}</small>
        </div>
        <div class="cockpit-local-grid">
          <div><span data-i18n>TEMP</span><strong id="cockpit-local-temperature">{{ b.local.temperature }}</strong><small translate="no">OPEN-METEO</small></div>
          <div><span data-i18n>WIND</span><strong id="cockpit-local-wind">{{ b.local.wind }}</strong><small id="cockpit-local-wind-direction">{{ b.local.windDirection }}</small></div>
          <div><span data-i18n>SKY</span><strong id="cockpit-local-condition">{{ b.local.condition }}</strong><small id="cockpit-local-cloud">{{ b.local.cloud }}</small></div>
          <div><span data-i18n>PRECIP</span><strong id="cockpit-local-precipitation">{{ b.local.precipitation }}</strong><small data-i18n>MM</small></div>
        </div>
        <a class="cockpit-weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener" data-i18n>Weather data by Open-Meteo.com</a>
      </section>
    </div>
    <footer class="cockpit-signal-footer">
      <span id="cockpit-brief-source">{{ b.source }}</span>
      <nav class="cockpit-brief-tabs" aria-label="Cockpit briefing pages" data-i18n-aria-label>
        <button type="button" data-cockpit-brief-index="0" aria-label="Show Live Signals" :aria-current="String(b.pageIndex === 0)" data-i18n-aria-label data-i18n>SIG</button>
        <button type="button" data-cockpit-brief-index="1" aria-label="Show Regional News" :aria-current="brief ? String(b.pageIndex === 1) : undefined" data-i18n-aria-label data-i18n>NEWS</button>
        <button type="button" data-cockpit-brief-index="2" aria-label="Show Local Info" :aria-current="brief ? String(b.pageIndex === 2) : undefined" data-i18n-aria-label data-i18n>LOCAL</button>
      </nav>
    </footer>
  </aside>
</template>
