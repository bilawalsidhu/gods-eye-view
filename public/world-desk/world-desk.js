const COLORS = {
  calamity: '#ff6b4a',
  war: '#ff4d6d',
  prophet: '#c77dff',
  birth: '#80ed99',
  death: '#adb5bd',
  discovery: '#00d4ff',
  empire: '#ffd166',
  politics: '#4cc9f0',
  science: '#72efdd',
  culture: '#f72585',
  space: '#e0aaff',
  live: '#ffe066',
};

const LIVE_CACHE_KEY = 'gev-world-desk-live-v1';
const WINDOW_YEARS = 40;

const $ = (id) => document.getElementById(id);

function formatYear(year) {
  if (year < 0) return `${Math.abs(year)} BCE`;
  return `${year} CE`;
}

function eventActive(event, year) {
  const start = Number(event.year);
  const rawEnd = event.yearEnd;
  const end = rawEnd == null || rawEnd === '' || !Number.isFinite(Number(rawEnd))
    ? start
    : Number(rawEnd);
  return start <= year + 8 && end >= year - WINDOW_YEARS;
}

function readLiveCache() {
  try {
    return JSON.parse(localStorage.getItem(LIVE_CACHE_KEY) || '{"days":{}}');
  } catch {
    return { days: {} };
  }
}

function writeLiveDay(isoDay, events) {
  const cache = readLiveCache();
  cache.days[isoDay] = { savedAt: Date.now(), events };
  const keys = Object.keys(cache.days).sort();
  while (keys.length > 90) {
    delete cache.days[keys.shift()];
  }
  localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cache));
}

function cachedLiveEvents() {
  const cache = readLiveCache();
  return Object.values(cache.days).flatMap((day) => day.events || []);
}

async function fetchLiveEvents() {
  const urls = ['/api/news', '/api/world-news'];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const payload = await response.json();
      const events = normalizeLivePayload(payload);
      if (events.length) {
        writeLiveDay(new Date().toISOString().slice(0, 10), events);
        return events;
      }
    } catch {
      /* try the next source */
    }
  }
  return cachedLiveEvents();
}

function normalizeLivePayload(payload) {
  if (Array.isArray(payload?.points)) {
    return payload.points.flatMap((point) => (point.articles || []).slice(0, 2).map((article, index) => ({
      id: `live-${point.id}-${index}`,
      year: new Date().getFullYear(),
      category: 'live',
      title: article.title,
      place: point.place,
      lat: point.lat,
      lon: point.lon,
      summary: `${article.domain || 'Publisher'} · coverage mention, not a verified incident.`,
      url: article.url,
      traditional: false,
      source: payload.source || 'GDELT DOC 2.0',
    })));
  }
  if (Array.isArray(payload?.articles)) {
    return payload.articles.slice(0, 40).map((article, index) => ({
      id: `live-article-${index}`,
      year: new Date().getFullYear(),
      category: 'live',
      title: article.title,
      place: article.sourceCountry || article.domain || 'Unknown',
      lat: 20,
      lon: 0,
      summary: 'Live public-news cache. Location may be outlet country only.',
      url: article.url,
      traditional: false,
      source: 'GDELT DOC 2.0',
    }));
  }
  return [];
}

function pinIcon(category) {
  const color = COLORS[category] || '#00d4ff';
  return L.divIcon({
    className: '',
    html: `<span class="desk-pin" style="display:block;width:14px;height:14px;background:${color};color:${color}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const state = {
  catalog: null,
  live: [],
  year: new Date().getFullYear(),
  categories: new Set(),
  playing: false,
  timer: null,
  markers: [],
  map: null,
};

function allEvents() {
  return [...(state.catalog?.events || []), ...state.live];
}

function visibleEvents() {
  return allEvents().filter((event) => (
    state.categories.has(event.category) && eventActive(event, state.year)
  ));
}

function renderFilters() {
  const row = $('filter-row');
  row.innerHTML = '';
  for (const cat of state.catalog.categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = cat.label;
    button.style.color = COLORS[cat.id] || '';
    button.setAttribute('aria-pressed', state.categories.has(cat.id) ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (state.categories.has(cat.id)) state.categories.delete(cat.id);
      else state.categories.add(cat.id);
      if (state.categories.size === 0) state.categories.add(cat.id);
      renderFilters();
      draw(state.map);
    });
    row.appendChild(button);
  }
}

function selectEvent(event, map) {
  const panel = $('selected');
  panel.hidden = !event;
  if (!event) return;
  $('selected-kicker').textContent = `${formatYear(event.year)}${event.yearEnd ? `–${formatYear(event.yearEnd)}` : ''} · ${event.category}${event.traditional ? ' · traditional date' : ''}`;
  $('selected-title').textContent = event.title;
  $('selected-place').textContent = event.place;
  $('selected-summary').textContent = event.summary;
  $('selected-source').textContent = event.source || '';
  if (Number.isFinite(event.lat) && Number.isFinite(event.lon)) {
    map.flyTo([event.lat, event.lon], Math.max(map.getZoom(), 4), { duration: 0.7 });
  }
}

function draw(map) {
  const events = visibleEvents();
  $('year-label').textContent = formatYear(state.year);
  $('roster-count').textContent = String(events.length);
  $('status').textContent = `${allEvents().length} records · ${events.length} in this window · live cache ${Object.keys(readLiveCache().days).length} day(s)`;

  for (const marker of state.markers) map.removeLayer(marker);
  state.markers = events.map((event) => {
    const marker = L.marker([event.lat, event.lon], { icon: pinIcon(event.category), title: event.title });
    marker.on('click', () => selectEvent(event, map));
    marker.addTo(map);
    return marker;
  });

  const roster = $('roster');
  roster.innerHTML = '';
  for (const event of events.slice().sort((a, b) => b.year - a.year).slice(0, 80)) {
    const item = document.createElement('li');
    item.innerHTML = `<button type="button"><span class="when">${formatYear(event.year)} · ${event.category}</span><span class="what">${event.title}</span></button>`;
    item.querySelector('button').addEventListener('click', () => selectEvent(event, map));
    roster.appendChild(item);
  }
}

function setYear(year, map) {
  state.year = Number(year);
  $('year').value = String(state.year);
  draw(map);
}

function togglePlay(map) {
  state.playing = !state.playing;
  $('btn-play').textContent = state.playing ? 'Pause' : 'Play';
  $('btn-play').setAttribute('aria-pressed', String(state.playing));
  clearInterval(state.timer);
  if (!state.playing) return;
  state.timer = setInterval(() => {
    const next = state.year >= state.catalog.eraEnd ? state.catalog.eraStart : state.year + (state.year < 1500 ? 20 : 2);
    setYear(next, map);
  }, 140);
}

async function main() {
  const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([20, 12], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 8,
  }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  state.map = map;
  const catalog = await (await fetch('./events.json')).json();
  state.catalog = catalog;
  state.year = catalog.eraEnd;
  $('year').min = String(catalog.eraStart);
  $('year').max = String(catalog.eraEnd);
  $('year').value = String(catalog.eraEnd);
  for (const cat of catalog.categories) state.categories.add(cat.id);
  renderFilters();
  draw(map);

  $('year').addEventListener('input', (event) => setYear(event.target.value, map));
  $('btn-now').addEventListener('click', () => setYear(catalog.eraEnd, map));
  $('btn-play').addEventListener('click', () => togglePlay(map));

  const live = await fetchLiveEvents();
  state.live = live;
  draw(map);
}

main().catch((error) => {
  $('status').textContent = `Catalog failed: ${error.message}`;
});
