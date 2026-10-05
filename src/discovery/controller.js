import { starterPack } from './starterPack.js';
import {
  createDiscoveryLookup,
  routingFeatures,
  proposeDiscoveryRoute,
} from './routing.js';
import { planetViewUrl } from './planetModel.js';
import { validateDiscoveryPack, createNearbyKnowledgeSource } from './model.js';
import {
  createDiscoveryStorage,
  exportDiscoveryFile,
  importDiscoveryFile,
} from './storage.js';
import {
  JOURNEYS,
  quizForCard,
  journeyProgressKey,
  createJourneyProgress,
} from './journeys.js';
const COPY = {
  en: {
    observeRouting: 'Observe local search routing',
    routingNote:
      'Optional local diagnostic: lookup time excludes rendering. Export contains counts and routes, not search text, coordinates or study answers. Recommendations never execute.',
    exportRouting: 'Export routing observations',
    clearRouting: 'Clear observations',
    routing: 'Local search observation',
    routingTiming: 'lookup only',
    routingModels: 'model calls',
    routingApis: 'local-lookup API calls',
    routingProposal: 'Shadow proposal',
    routingNoAct: 'no auto-act',
    routingCount: 'observations',
    planet: 'Open planetary view',
    learn: 'Learn from the cards',
    freeExplore: 'Free exploration',
    previous: 'Previous step',
    next: 'Next step',
    resetLearning: 'Reset local study progress',
    correct: 'Matches this source snapshot.',
    incorrect: 'This choice does not match the installed source snapshot.',
    missingLesson:
      'This step’s source card is missing from the installed library. Import the matching public pack or continue to another step.',
    progressNote:
      'Study progress stays in this browser and is not exported in public packs. This is source-reading practice, not a mastery assessment.',
    quizSource: 'Read the source revision',
    filterCoordinates: 'Filter at these coordinates',
    title: 'DISCOVERY ATLAS',
    intro:
      'A small, source-linked library. Search installed cards without a model or network call. Wikipedia and official links open online; full articles and maps are separate.',
    search: 'Search the local library',
    body: 'World',
    kind: 'Category',
    nearby: 'Use the observed Earth center',
    web: 'Fetch nearby public cards',
    consent: 'Allow geographic web lookup (coordinates only, maximum 10 km)',
    selected: 'Selected vehicle type',
    import: 'Import public pack',
    export: 'Export public pack',
    reset: 'Reset to bundled library',
    offline: 'Install offline library',
    close: 'Close',
    open: 'DISCOVER',
    global: 'All installed cards',
    radius: 'Radius (km)',
    empty:
      'No installed card matches. This small selection is not a complete atlas.',
    local: 'Local library',
    failure:
      'Action unavailable. Check the selected world, coordinates, connectivity or pack format.',
    saved: 'Public library stored on this device.',
    installed: 'Offline library installed. Open /discovery.html when offline.',
    notInstalled:
      'Offline installation is available from the built discovery page.',
    notVehicle:
      'No sourced card matches the selected vehicle type. No identification inferred.',
    fly: 'Go to this place',
    noFly:
      'Open a separate spherical overview. Install that page separately for offline use; detailed terrain is not included.',
    found:
      'Public cards fetched and saved. Nearby does not establish identity.',
    pack: 'Starter selection',
    unknown: 'No description supplied by this source.',
    clear: 'Clear proximity filter',
    world:
      'Body-specific coordinates; Moon/Mars cards are not positioned on the Earth globe.',
  },
  fr: {
    observeRouting: 'Observer le routage de la recherche locale',
    routingNote:
      'Diagnostic local facultatif : le temps exclut le rendu. L’export contient des compteurs et routes, pas le texte recherché, les coordonnées ou les réponses aux quiz. Les recommandations n’exécutent rien.',
    exportRouting: 'Exporter les observations de routage',
    clearRouting: 'Effacer les observations',
    routing: 'Observation de recherche locale',
    routingTiming: 'recherche seule',
    routingModels: 'appels de modèle',
    routingApis: 'appels API de recherche locale',
    routingProposal: 'Proposition en observation',
    routingNoAct: 'aucune action automatique',
    routingCount: 'observations',
    planet: 'Ouvrir la vue planétaire',
    learn: 'Apprendre à partir des fiches',
    freeExplore: 'Exploration libre',
    previous: 'Étape précédente',
    next: 'Étape suivante',
    resetLearning: 'Effacer la progression locale',
    correct: 'Correspond à cette version de la source.',
    incorrect:
      'Ce choix ne correspond pas à la version de la source installée.',
    missingLesson:
      'La fiche source de cette étape manque dans la bibliothèque installée. Importer le pack public correspondant ou passer à une autre étape.',
    progressNote:
      'La progression reste dans ce navigateur et n’est pas exportée dans les packs publics. Il s’agit de lecture des sources, pas d’une évaluation de maîtrise.',
    quizSource: 'Consulter la révision source',
    filterCoordinates: 'Filtrer à ces coordonnées',
    title: 'ATLAS DE DÉCOUVERTE',
    intro:
      'Une petite bibliothèque reliée aux sources. Les fiches installées se consultent sans modèle ni réseau. Wikipédia et les liens officiels s’ouvrent en ligne ; articles complets et cartes sont séparés.',
    search: 'Rechercher dans la bibliothèque locale',
    body: 'Astre',
    kind: 'Catégorie',
    nearby: 'Utiliser le centre terrestre observé',
    web: 'Charger les fiches publiques proches',
    consent:
      'Autoriser la recherche géographique web (coordonnées seules, 10 km maximum)',
    selected: 'Type du véhicule sélectionné',
    import: 'Importer un pack public',
    export: 'Exporter le pack public',
    reset: 'Revenir à la bibliothèque fournie',
    offline: 'Installer la bibliothèque hors ligne',
    close: 'Fermer',
    open: 'DÉCOUVRIR',
    global: 'Toutes les fiches installées',
    radius: 'Rayon (km)',
    empty:
      'Aucune fiche installée ne correspond. Cette petite sélection n’est pas un atlas complet.',
    local: 'Bibliothèque locale',
    failure:
      'Action indisponible. Vérifier l’astre, les coordonnées, la connexion ou le format du pack.',
    saved: 'Bibliothèque publique conservée sur cet appareil.',
    installed:
      'Bibliothèque hors ligne installée. Ouvrir /discovery.html hors connexion.',
    notInstalled:
      'Installation hors ligne disponible sur la page découverte compilée.',
    notVehicle:
      'Aucune fiche sourcée ne correspond au type du véhicule sélectionné. Aucune identité déduite.',
    fly: 'Rejoindre ce lieu',
    noFly:
      'Ouvrir un aperçu sphérique séparé. Installer cette page séparément pour le hors ligne ; le relief détaillé n’est pas inclus.',
    found:
      'Fiches publiques chargées et conservées. La proximité ne prouve pas l’identité.',
    pack: 'Sélection initiale',
    unknown: 'Aucune description fournie par cette source.',
    clear: 'Effacer le filtre de proximité',
    world:
      'Coordonnées propres à chaque astre ; les fiches Lune/Mars ne sont pas placées sur le globe terrestre.',
  },
};

/** Public-only knowledge UI; no private vault, live search by person or model dependency. */
export function initDiscovery({
  document,
  storage = createDiscoveryStorage(),
  source = createNearbyKnowledgeSource(),
  getArea = null,
  getSelectedType = null,
  navigate = null,
  installOffline = null,
  progress = createJourneyProgress(),
} = {}) {
  const el = (id) => document.getElementById(`discovery-${id}`);
  const dialog = el('dialog');
  let journeyId = '',
    stepIndex = 0;
  let library = storage.load() ?? validateDiscoveryPack(starterPack),
    language = 'en',
    center = null,
    controller = null,
    generation = 0,
    background = null,
    busy = false;
  const listeners = [];
  const lookup = createDiscoveryLookup(library);
  const syncLookup = () => lookup.setPack(library);
  const copy = () => COPY[language];
  const status = (message) => {
    el('status').textContent = message;
  };
  const listen = (id, name, fn) => {
    const node = el(id);
    node.addEventListener(name, fn);
    listeners.push(() => node.removeEventListener(name, fn));
  };
  function render() {
    el('list').replaceChildren();
    const body = el('body').value;
    const result = lookup.lookup(
      {
        query: el('query').value,
        body,
        kind: el('kind').value,
        center,
        radiusKm: Number(el('radius').value) || 10,
      },
      {
        observe: el('observe-routing').checked,
        allowWeb: el('allow-web').checked,
      },
    );
    const rows = result.rows;
    if (el('observe-routing').checked) {
      const proposal = proposeDiscoveryRoute(routingFeatures(result.trace));
      const summary = `${result.trace.route} · ${result.trace.elapsedMs.toFixed(3)} ms ${copy().routingTiming} · ${result.trace.modelCalls} ${copy().routingModels} · ${result.trace.apiCalls} ${copy().routingApis}\n${copy().routingProposal}: ${proposal.route} · ${copy().routingNoAct}\n${lookup.getObservations().length} ${copy().routingCount}`;
      el('routing-summary').textContent = summary;
    } else el('routing-summary').textContent = '';
    const count = `${rows.length} / ${library.cards.filter((card) => card.body === body).length} · ${copy().local} · CC0`;
    el('count').textContent = count;
    el('selection').textContent = library.selection;
    el('nearby').disabled = body !== 'earth' || !getArea;
    el('selected').disabled = body !== 'earth' || !getSelectedType;
    el('web').disabled = body !== 'earth';
    el('offline').disabled = !installOffline;
    el('lon').max = body === 'earth' ? '180' : '360';
    renderJourney();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = copy().empty;
      el('list').append(empty);
    }
    for (const { card, distanceKm } of rows) {
      const item = document.createElement('article');
      item.className = 'discovery-card';
      const top = document.createElement('p');
      top.className = 'discovery-card-meta';
      top.textContent = `${card.body.toUpperCase()} · ${card.kind.replaceAll('-', ' ')} · ${card.id}`;
      const title = document.createElement('h3');
      title.textContent = card.labels[language];
      const description = document.createElement('p');
      description.textContent = card.descriptions[language] || copy().unknown;
      item.append(top, title, description);
      if (card.coordinate) {
        const coordinates = document.createElement('p');
        coordinates.className = 'discovery-card-meta';
        const text = `${card.coordinate.lat.toFixed(4)}, ${card.coordinate.lon.toFixed(4)} · ${distanceKm === null ? '' : `${distanceKm.toFixed(1)} km`}`;
        coordinates.textContent = text;
        item.append(coordinates);
      }
      if (card.kind === 'vehicle-type') {
        const boundary = document.createElement('p');
        boundary.className = 'discovery-boundary';
        boundary.textContent = card.association;
        item.append(boundary);
      }
      const facts = document.createElement('dl');
      for (const fact of card.facts) {
        const name = document.createElement('dt');
        name.textContent = fact.label;
        const value = document.createElement('dd');
        value.textContent = fact.value;
        facts.append(name, value);
      }
      item.append(facts);
      const links = document.createElement('nav');
      links.className = 'discovery-card-links';
      links.setAttribute('aria-label', `Sources ${card.labels[language]}`);
      for (const [label, url] of [
        ['Wikidata', card.provenance.sourceUrl],
        ['Wikipedia', card.articles[language] ?? card.articles.en],
        ['Official / Officiel', card.officialSite],
      ])
        if (url) {
          const a = document.createElement('a');
          a.textContent = label;
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          links.append(a);
        }
      const date = document.createElement('p');
      date.className = 'discovery-card-meta';
      const sourceDate = `Wikidata · CC0 · ${card.provenance.retrievedAt} · revision ${card.provenance.revision ?? 'unknown'}`;
      date.textContent = sourceDate;
      item.append(links, date);
      if (card.coordinate && card.body === 'earth' && navigate) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = copy().fly;
        button.addEventListener('click', () => {
          close();
          void Promise.resolve(navigate(card)).catch(() =>
            status(copy().failure),
          );
        });
        item.append(button);
      } else if (card.body !== 'earth') {
        const note = document.createElement('p');
        note.className = 'discovery-boundary';
        note.textContent = copy().noFly;
        item.append(note);
        const view = document.createElement('a');
        view.href = planetViewUrl(card);
        view.target = '_blank';
        view.rel = 'noopener noreferrer';
        view.textContent = copy().planet;
        item.append(view);
      }
      el('list').append(item);
    }
  }
  function currentJourney() {
    return JOURNEYS.find((journey) => journey.id === journeyId);
  }
  function showJourneyStep() {
    const journey = currentJourney();
    if (!journey) {
      render();
      return;
    }
    const id = journey.steps[stepIndex];
    const card = library.cards.find((card) => card.id === id);
    center = null;
    el('query').value = id;
    el('kind').value = 'all';
    if (card) {
      el('body').value = card.body;
      el('lat').value = card.coordinate?.lat ?? '';
      el('lon').value = card.coordinate?.lon ?? '';
    }
    render();
  }
  function endJourney() {
    journeyId = '';
    stepIndex = 0;
    el('journey').value = '';
  }
  function renderJourney() {
    const journey = currentJourney();
    el('quiz').replaceChildren();
    el('previous').disabled = !journey || stepIndex === 0;
    el('next').disabled = !journey || stepIndex >= journey.steps.length - 1;
    el('journey-description').textContent = journey
      ? journey.intro[language]
      : copy().progressNote;
    if (!journey) {
      el('journey-progress').textContent = '';
      return;
    }
    const installed = journey.steps.map((id) =>
      library.cards.find((card) => card.id === id),
    );
    const answered = installed.filter((card) => {
      const quiz = quizForCard(card);
      return (
        card && quiz && progress.get(journeyProgressKey(journey.id, card, quiz))
      );
    }).length;
    const summary = `${stepIndex + 1}/${journey.steps.length} · ${answered}/${journey.steps.length} answers recorded / réponses conservées`;
    el('journey-progress').textContent = summary;
    const card = installed[stepIndex];
    const quiz = quizForCard(card);
    if (!card || !quiz) {
      const missing = document.createElement('p');
      missing.textContent = copy().missingLesson;
      el('quiz').append(missing);
      return;
    }
    const key = journeyProgressKey(journey.id, card, quiz);
    const question = document.createElement('p');
    question.className = 'discovery-quiz-question';
    question.textContent = quiz.prompts[language];
    const choices = document.createElement('div');
    choices.className = 'discovery-actions';
    const answer = progress.get(key);
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    if (answer)
      feedback.textContent = answer.correct ? copy().correct : copy().incorrect;
    quiz.choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      const label = ['earth', 'moon', 'mars'].includes(choice)
        ? {
            earth: language === 'fr' ? 'Terre' : 'Earth',
            moon: language === 'fr' ? 'Lune' : 'Moon',
            mars: 'Mars',
          }[choice]
        : choice;
      button.textContent = label;
      button.setAttribute('aria-pressed', String(answer?.choice === index));
      button.addEventListener('click', () => {
        try {
          progress.record(key, index, index === quiz.correctIndex);
          renderJourney();
        } catch {
          status(copy().failure);
        }
      });
      choices.append(button);
    });
    const link = document.createElement('a');
    link.href = quiz.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = copy().quizSource;
    el('quiz').append(question, choices, feedback, link);
  }
  function translate() {
    language = el('language').value === 'fr' ? 'fr' : 'en';
    for (const node of document.querySelectorAll('[data-discovery-copy]'))
      node.textContent = copy()[node.dataset.discoveryCopy];
    dialog.lang = language;
    for (const option of el('journey').options)
      option.textContent = option.value
        ? JOURNEYS.find((journey) => journey.id === option.value)?.labels[
            language
          ]
        : copy().freeExplore;
    render();
  }
  function open() {
    if (!dialog.hidden) return;
    dialog.hidden = false;
    background = new Map();
    for (const child of document.body.children)
      if (child !== dialog) {
        background.set(child, child.inert);
        child.inert = true;
      }
    el('close').focus();
    translate();
  }
  function close() {
    dialog.hidden = true;
    generation++;
    controller?.abort();
    controller = null;
    for (const [node, inert] of background ?? []) node.inert = inert;
    background = null;
    el('open').focus();
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    const epoch = generation;
    const controls = [...dialog.querySelectorAll('button,input,select')].filter(
      (node) => node !== el('close'),
    );
    const original = new Map(controls.map((node) => [node, node.disabled]));
    controls.forEach((node) => (node.disabled = true));
    const current = () => {
      if (epoch !== generation || dialog.hidden) throw new Error('Closed.');
    };
    try {
      await fn(current);
    } catch {
      if (epoch === generation) status(copy().failure);
    } finally {
      busy = false;
      for (const [node, disabled] of original) node.disabled = disabled;
      if (!dialog.hidden) render();
    }
  }
  listen('open', 'click', open);
  listen('close', 'click', close);
  listen('language', 'change', translate);
  listen('allow-web', 'change', render);
  listen('query', 'input', () => {
    endJourney();
    render();
  });
  listen('kind', 'change', () => {
    endJourney();
    render();
  });
  listen('radius', 'change', () => {
    try {
      render();
    } catch {
      status(copy().failure);
    }
  });
  listen('body', 'change', () => {
    endJourney();
    center = null;
    el('lat').value = '';
    el('lon').value = '';
    render();
  });
  listen('clear', 'click', () => {
    center = null;
    render();
  });
  listen('filter-coordinates', 'click', () => {
    endJourney();
    try {
      if (!el('lat').value.trim() || !el('lon').value.trim())
        throw new Error('Coordinates required.');
      center = { lat: Number(el('lat').value), lon: Number(el('lon').value) };
      render();
    } catch {
      center = null;
      status(copy().failure);
    }
  });
  listen('nearby', 'click', () => {
    endJourney();
    try {
      const area = getArea();
      center = { lat: area.lat, lon: area.lon };
      el('lat').value = area.lat;
      el('lon').value = area.lon;
      render();
    } catch {
      status(copy().failure);
    }
  });
  listen('selected', 'click', () => {
    endJourney();
    const type = getSelectedType?.();
    const alias = String(type ?? '').toLowerCase();
    const match = library.cards.find(
      (card) =>
        card.kind === 'vehicle-type' &&
        card.aliases.some((value) =>
          new RegExp(
            `(^|[^a-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase()}([^a-z0-9]|$)`,
            'i',
          ).test(alias),
        ),
    );
    if (!match) {
      status(copy().notVehicle);
      return;
    }
    center = null;
    el('query').value = match.id;
    el('kind').value = 'vehicle-type';
    el('body').value = 'earth';
    render();
  });
  listen('web', 'click', () =>
    action(async (current) => {
      if (
        !el('allow-web').checked ||
        el('body').value !== 'earth' ||
        !el('lat').value.trim() ||
        !el('lon').value.trim()
      )
        throw new Error('Explicit geographic lookup required.');
      controller = new AbortController();
      const cards = await source.nearby(
        {
          lat: Number(el('lat').value),
          lon: Number(el('lon').value),
          radiusKm: Math.min(Number(el('radius').value), 10),
          language,
        },
        { signal: controller.signal },
      );
      current();
      const merged = new Map(library.cards.map((card) => [card.id, card]));
      cards.forEach((card) => merged.set(card.id, card));
      const next = validateDiscoveryPack({
        ...library,
        title: 'Local public discovery library',
        cards: [...merged.values()],
      });
      current();
      storage.save(next);
      library = next;
      syncLookup();
      center = { lat: Number(el('lat').value), lon: Number(el('lon').value) };
      el('query').value = '';
      render();
      status(copy().found);
      controller = null;
    }),
  );
  listen('export', 'click', () =>
    action(async (current) => {
      const file = await exportDiscoveryFile(library);
      current();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'discovery-public-pack.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(copy().saved);
    }),
  );
  listen('import-file', 'change', () =>
    action(async (current) => {
      const file = el('import-file').files?.[0];
      if (!file || file.size > 2 * 1024 * 1024)
        throw new Error('Pack limit is 2 MiB.');
      const text = await file.text();
      current();
      const pack = await importDiscoveryFile(text);
      current();
      storage.save(pack);
      library = pack;
      syncLookup();
      center = null;
      render();
      el('import-file').value = '';
      status(copy().saved);
    }),
  );
  listen('reset', 'click', () => {
    endJourney();
    storage.clear();
    library = validateDiscoveryPack(starterPack);
    syncLookup();
    center = null;
    el('query').value = '';
    render();
    status(copy().local);
  });
  listen('offline', 'click', () =>
    action(async (current) => {
      if (!installOffline) {
        status(copy().notInstalled);
        return;
      }
      await installOffline();
      current();
      status(copy().installed);
    }),
  );
  listen('journey', 'change', () => {
    journeyId = el('journey').value;
    stepIndex = 0;
    if (!journeyId) el('query').value = '';
    showJourneyStep();
  });
  listen('previous', 'click', () => {
    const journey = currentJourney();
    if (journey) {
      stepIndex = Math.max(0, stepIndex - 1);
      showJourneyStep();
    }
  });
  listen('next', 'click', () => {
    const journey = currentJourney();
    if (journey) {
      stepIndex = Math.min(journey.steps.length - 1, stepIndex + 1);
      showJourneyStep();
    }
  });
  listen('reset-learning', 'click', () => {
    try {
      progress.clear();
      renderJourney();
    } catch {
      status(copy().failure);
    }
  });
  listen('observe-routing', 'change', render);
  listen('clear-routing', 'click', () => {
    lookup.clearObservations();
    el('routing-summary').textContent = '';
  });
  listen('export-routing', 'click', () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(lookup.exportObservations(), null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'discovery-routing-observations.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  listen('dialog', 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') {
      const nodes = [
        ...dialog.querySelectorAll('button,input,select,a[href]'),
      ].filter((node) => !node.disabled && !node.hidden);
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    }
  });
  translate();
  return {
    open,
    close,
    destroy() {
      close();
      lookup.clearObservations();
      listeners.splice(0).forEach((remove) => remove());
    },
  };
}
