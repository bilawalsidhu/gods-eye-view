import { starterPack } from './starterPack.js';
import { createDiscoveryStorage } from './storage.js';
import { PLANETS, planetPoint, projectPlanetPoint } from './planetModel.js';
import { createPlanetRenderer } from './planetRenderer.js';
import './planet.css';
const el = (id) => document.getElementById(`planet-${id}`);
const library = createDiscoveryStorage().load() ?? starterPack;
const requested = new URLSearchParams(location.search);
let body = requested.get('body') ?? 'moon',
  renderer = null,
  language = 'en',
  selected = null,
  epoch = 0;
const COPY = {
  en: {
    title: 'PLANETARY ATLAS',
    intro:
      'Static spherical overview. Drag to rotate, scroll to zoom. No detailed terrain, real-time phase, Earth layers or mineral analysis.',
    ready: 'Local map ready.',
    offline: 'Install offline planetary views',
    installed: 'Planetary page, maps and local code cached for offline use.',
    failed: 'Planetary view unavailable.',
    overview: 'Global view',
    focus: 'Go to coordinates',
    source: 'Map source',
    pick: 'Picked coordinates',
    empty: 'No selected site. This is a spherical overview.',
  },
  fr: {
    title: 'ATLAS PLANÉTAIRE',
    intro:
      'Aperçu sphérique statique. Glisser pour tourner, molette pour zoomer. Pas de relief détaillé, de phase en temps réel, de couches terrestres ni d’analyse minérale.',
    ready: 'Carte locale prête.',
    offline: 'Installer les vues planétaires hors ligne',
    installed: 'Page, cartes et code local conservés pour le hors ligne.',
    failed: 'Vue planétaire indisponible.',
    overview: 'Vue globale',
    focus: 'Rejoindre les coordonnées',
    source: 'Source cartographique',
    pick: 'Coordonnées pointées',
    empty: 'Aucun site sélectionné. Il s’agit d’un aperçu sphérique.',
  },
};
const copy = () => COPY[language];
let sites = [];
function translate() {
  language = el('language').value === 'fr' ? 'fr' : 'en';
  for (const node of document.querySelectorAll('[data-planet-copy]'))
    node.textContent = copy()[node.dataset.planetCopy];
  el('card-title').textContent = selected?.labels[language] ?? copy().empty;
  el('description').textContent = selected?.descriptions[language] ?? '';
  for (const link of el('links').querySelectorAll('a'))
    if (link.textContent === 'Wikipedia' && selected)
      link.href = selected.articles[language] ?? selected.articles.en;
  document.documentElement.lang = language;
  const planet = PLANETS[body];
  if (planet) {
    const facts = `${planet.labels[language]} · ${language === 'fr' ? 'rayon moyen' : 'mean radius'} ${planet.radiusKm} km · ~${((2 * Math.PI * planet.radiusKm) / planet.width).toFixed(1)} km/pixel · ${planet.width}×${planet.height}`;
    el('facts').textContent = facts;
  }
  for (const option of el('sites').options) {
    const card = sites.find((card) => card.id === option.value);
    option.textContent = card ? card.labels[language] : copy().overview;
  }
  for (const marker of el('markers').children) {
    const card = sites.find((card) => card.id === marker.dataset.id);
    if (card) marker.textContent = card.labels[language];
  }
}
function showCard(card) {
  selected = card;
  translate();
  el('links').replaceChildren();
  for (const [label, url] of [
    ['Wikidata', card.provenance.sourceUrl],
    ['Wikipedia', card.articles[language] ?? card.articles.en],
  ])
    if (url) {
      const link = document.createElement('a');
      link.textContent = label;
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      el('links').append(link);
    }
  const point = planetPoint(card, body);
  el('lat').value = point.lat.toFixed(4);
  el('lon').value = point.lon.toFixed(4);
  renderer?.focus(point);
}
function markers(center, zoom) {
  const rect = el('canvas').getBoundingClientRect();
  for (const button of el('markers').children) {
    const card = sites.find((card) => card.id === button.dataset.id);
    const point = projectPlanetPoint(planetPoint(card, body), center, {
      width: rect.width,
      height: rect.height,
      zoom,
    });
    button.hidden = !point.visible;
    button.style.left = `${point.x}px`;
    button.style.top = `${point.y}px`;
  }
}
async function switchBody(next, siteId = null) {
  if (!PLANETS[next]) throw new Error('Unsupported planetary body.');
  const generation = ++epoch;
  body = next;
  selected = null;
  renderer?.destroy();
  renderer = null;
  el('body').disabled = true;
  el('status').textContent =
    'Loading local map / Chargement de la carte locale…';
  el('links').replaceChildren();
  el('lat').value = '';
  el('lon').value = '';
  el('body').value = body;
  el('markers').replaceChildren();
  el('sites').replaceChildren();
  const globalOption = document.createElement('option');
  globalOption.value = '';
  globalOption.textContent = copy().overview;
  el('sites').append(globalOption);
  sites = library.cards.filter((card) => card.body === body && card.coordinate);
  const planet = PLANETS[body];
  el('credit').textContent = planet.credit;
  el('source').href = planet.sourceUrl;
  const facts = `${planet.labels[language]} · mean radius ${planet.radiusKm} km · ~${((2 * Math.PI * planet.radiusKm) / planet.width).toFixed(1)} km/pixel at equator · ${planet.width}×${planet.height}`;
  el('facts').textContent = facts;
  el('map-note').textContent = planet.note;
  for (const card of sites) {
    const option = document.createElement('option');
    option.value = card.id;
    option.textContent = card.labels[language];
    el('sites').append(option);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.hidden = true;
    marker.dataset.id = card.id;
    marker.textContent = card.labels[language];
    marker.addEventListener('click', () => showCard(card));
    el('markers').append(marker);
  }
  const created = await createPlanetRenderer({
    canvas: el('canvas'),
    textureUrl: planet.texture,
    onChange: markers,
    onPick: (point) => {
      selected = null;
      el('sites').value = '';
      el('links').replaceChildren();
      translate();
      el('lat').value = point.lat.toFixed(4);
      el('lon').value = point.lon.toFixed(4);
      const text = `${copy().pick}: ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
      el('status').textContent = text;
    },
  });
  if (generation !== epoch) {
    created.destroy();
    return;
  }
  renderer = created;
  el('body').disabled = false;
  translate();
  el('status').textContent = copy().ready;
  const requestedCard = sites.find((card) => card.id === siteId);
  if (requestedCard) {
    el('sites').value = requestedCard.id;
    showCard(requestedCard);
  }
  if (siteId && !requestedCard)
    el('status').textContent =
      'Source site not installed for this body / Site absent pour cet astre.';
}
el('language').addEventListener('change', translate);
el('body').addEventListener('change', () => {
  void switchBody(el('body').value).catch(() => {
    el('body').disabled = false;
    el('status').textContent = copy().failed;
  });
});
el('overview').addEventListener('click', () => renderer?.overview());
el('sites').addEventListener('change', () => {
  const card = sites.find((card) => card.id === el('sites').value);
  if (card) showCard(card);
});
el('focus').addEventListener('click', () => {
  const lat = Number(el('lat').value),
    lon = Number(el('lon').value);
  if (
    el('lat').value.trim() &&
    el('lon').value.trim() &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 89 &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 360
  ) {
    selected = null;
    el('sites').value = '';
    el('links').replaceChildren();
    translate();
    renderer?.focus({ lat, lon });
  } else el('status').textContent = copy().failed;
});
el('offline').addEventListener('click', async () => {
  try {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator))
      throw new Error('Use built page.');
    const registration = await navigator.serviceWorker.register(
      '/planet-sw.js',
      { scope: '/planet.html' },
    );
    const worker =
      registration.installing ?? registration.waiting ?? registration.active;
    if (worker.state === 'activated')
      await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(
          () => reject(new Error('Offline refresh timed out.')),
          30000,
        );
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          channel.port1.close();
          event.data?.ok
            ? resolve()
            : reject(new Error('Offline refresh failed.'));
        };
        worker.postMessage({ type: 'REFRESH_PLANET_SHELL' }, [channel.port2]);
      });
    if (worker.state !== 'activated')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Offline install timed out.')),
          30000,
        );
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') {
            clearTimeout(timer);
            resolve();
          } else if (worker.state === 'redundant') {
            clearTimeout(timer);
            reject(new Error('Offline install failed.'));
          }
        });
      });
    el('status').textContent = copy().installed;
  } catch {
    el('status').textContent = copy().failed;
  }
});
window.addEventListener(
  'beforeunload',
  () => {
    epoch++;
    renderer?.destroy();
  },
  { once: true },
);
translate();
void switchBody(body, requested.get('site')).catch(() => {
  el('body').disabled = false;
  el('status').textContent = copy().failed;
});
