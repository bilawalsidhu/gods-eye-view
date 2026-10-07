export const JOURNEYS = Object.freeze([
  {
    id: 'monuments',
    labels: {
      en: 'Monuments through the sources',
      fr: 'Monuments au fil des sources',
    },
    intro: {
      en: 'Compare the dates and dimensions recorded by each source. An inception date is not necessarily an opening date.',
      fr: 'Comparer les dates et dimensions enregistrées par les sources. Une date de création n’est pas forcément une date d’ouverture.',
    },
    steps: ['Q37200', 'Q39671', 'Q10285', 'Q9141', 'Q676203', 'Q243'],
  },
  {
    id: 'other-worlds',
    labels: {
      en: 'Four places beyond Earth',
      fr: 'Quatre lieux au-delà de la Terre',
    },
    intro: {
      en: 'Read the body and coordinates before comparing places. These cards do not reconstruct a planetary globe.',
      fr: 'Lire l’astre et les coordonnées avant de comparer des lieux. Ces fiches ne reconstruisent pas un globe planétaire.',
    },
    steps: ['Q732758', 'Q631696', 'Q520', 'Q621110'],
  },
  {
    id: 'aircraft-families',
    labels: {
      en: 'Aircraft families, not identities',
      fr: 'Familles d’avions, pas identités',
    },
    intro: {
      en: 'Compare family-level information. A type card does not identify a particular live aircraft.',
      fr: 'Comparer les informations de famille. Une fiche de type n’identifie pas un avion observé en particulier.',
    },
    steps: ['Q6475', 'Q6387'],
  },
]);
/** Deterministic source-reading quiz: every answer points to an installed field. */
export function quizForCard(card) {
  if (!card || card.provenance?.source !== 'Wikidata') return null;
  let property = 'source',
    answer = 'Wikidata',
    choices = ['Wikidata', 'SoilGrids', 'OpenSky'];
  let prompts = {
    en: 'Which primary source is recorded on this card?',
    fr: 'Quelle source principale est indiquée sur cette fiche ?',
  };
  const height =
    card.kind !== 'vehicle-type'
      ? card.facts.find(
          (fact) =>
            fact.property === 'P2048' && /^\d+(?:\.\d+)? m$/.test(fact.value),
        )
      : null;
  if (height && Number.parseFloat(height.value) >= 0.1) {
    property = 'P2048';
    answer = height.value;
    const value = Number.parseFloat(answer);
    choices = [
      answer,
      `${Math.round(value * 1.5 * 100) / 100} m`,
      `${Math.round(value * 0.5 * 100) / 100} m`,
    ];
    prompts = {
      en: 'According to this installed source snapshot, what height is recorded?',
      fr: 'Selon cette version de la source installée, quelle hauteur est indiquée ?',
    };
  } else if (card.coordinate) {
    property = 'P625';
    answer = card.body;
    choices = ['earth', 'moon', 'mars'];
    prompts = {
      en: 'Which body is attached to these coordinates?',
      fr: 'À quel astre ces coordonnées sont-elles rattachées ?',
    };
  }
  const shift = Number(card.id.slice(1)) % choices.length;
  choices = [...choices.slice(shift), ...choices.slice(0, shift)];
  return {
    key: `${property}_${answer.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    prompts,
    choices,
    correctIndex: choices.indexOf(answer),
    answer,
    property,
    sourceUrl: card.provenance.revision
      ? `https://www.wikidata.org/w/index.php?title=${card.id}&oldid=${card.provenance.revision}`
      : card.provenance.sourceUrl,
    revision: card.provenance.revision,
  };
}
export function journeyProgressKey(journeyId, card, quiz) {
  if (
    !JOURNEYS.some((journey) => journey.id === journeyId) ||
    !/^Q[1-9]\d*$/.test(card.id) ||
    !quiz
  )
    throw new Error('Invalid lesson.');
  return `${journeyId}.${card.id}.${card.provenance.revision ?? 0}.${quiz.key}`;
}
/** Anonymous local study state only; never included in a public pack or web input. */
export function createJourneyProgress(storage = null) {
  if (!storage) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null;
    }
  }
  const key = 'gods-eye-view.discovery.learning.v1';
  let entries = {};
  try {
    const raw = storage?.getItem(key);
    if (raw && raw.length < 30000) {
      const value = JSON.parse(raw);
      if (
        value.version === 1 &&
        value.entries &&
        typeof value.entries === 'object'
      )
        for (const [k, v] of Object.entries(value.entries).slice(-100))
          if (
            /^(monuments|other-worlds|aircraft-families)\.Q\d+\.\d+\.[a-zA-Z0-9_-]{1,100}$/.test(
              k,
            ) &&
            Number.isInteger(v.choice) &&
            v.choice >= 0 &&
            v.choice < 3 &&
            typeof v.correct === 'boolean'
          )
            entries[k] = { choice: v.choice, correct: v.correct };
    }
  } catch {
    entries = {};
  }
  function persist() {
    if (storage) storage.setItem(key, JSON.stringify({ version: 1, entries }));
  }
  return {
    get: (key) => entries[key] ?? null,
    record(key, choice, correct) {
      if (
        !/^(monuments|other-worlds|aircraft-families)\.Q\d+\.\d+\.[a-zA-Z0-9_-]{1,100}$/.test(
          key,
        ) ||
        !Number.isInteger(choice) ||
        choice < 0 ||
        choice > 2 ||
        typeof correct !== 'boolean'
      )
        throw new Error('Invalid quiz record.');
      entries[key] = { choice, correct };
      entries = Object.fromEntries(Object.entries(entries).slice(-100));
      persist();
    },
    clear() {
      entries = {};
      storage?.removeItem(key);
    },
    persistent: Boolean(storage),
  };
}
