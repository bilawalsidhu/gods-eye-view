/**
 * The one adapter from a tool result to what the voice card shows.
 *
 * Most tools carry a card-ready `display` ({title, lines, chips, notes,
 * sources}) from their speech builder. The analyst instead returns semantic
 * fields the engine owns (count, complete, scopeLabel, partial, and a
 * `display` of scope, window and caveat). This module turns those into the
 * card shape so every result renders the same way, and names the numbered
 * referents the card lists (the referent registry reads the same answer, so
 * "the second one" always means the second row on screen).
 *
 * Pure: no DOM, no Cesium.
 * @module voice/resultDisplay
 */

import { voiceLayer } from './layerManifest.js';
import { t } from '../i18n/index.js';

/** Layer nouns, as message keys resolved at compose time. */
const LAYER_NOUN_KEYS = Object.freeze({
  flights: 'voice.noun.aircraft',
  military: 'voice.noun.militaryAircraft',
  'local-adsb': 'voice.noun.aircraft',
  'ais-live-vessels': 'voice.noun.ships',
  satellites: 'voice.noun.satellites',
  'rocket-launches': 'voice.noun.launches',
  earthquakes: 'voice.noun.earthquakes',
  'local-firms': 'voice.noun.fires',
});

/** Split "a; b" caveat text into separate notes. */
function notesOf(...values) {
  return [
    ...new Set(
      values
        .flatMap((value) => String(value || '').split(/;\s*/))
        .map((text) =>
          text
            .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

export function analystNounFor(layerKeys) {
  const keys = [...new Set(layerKeys.filter(Boolean))];
  if (keys.length !== 1) return t('voice.noun.results');
  const key = keys[0];
  const nounKey = LAYER_NOUN_KEYS[key];
  if (nounKey) return t(nounKey);
  return voiceLayer(key)?.aliases?.[0] || t('voice.noun.results');
}

/** The count/scope headline shared by the analyst card and spoken answer. */
const ANALYST_HEADLINE_MAX = 64;

function boundedHeadline(value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= ANALYST_HEADLINE_MAX) return text;
  return `${text.slice(0, ANALYST_HEADLINE_MAX - 1).trimEnd()}…`;
}

export function analystHeadline(result) {
  const keys = (result?.coverage?.layersQueried || []).map(
    (layer) => layer.layerKey,
  );
  const count = Number(result?.count) || 0;
  const countText = `${result?.complete === false ? t('voice.result.atLeast') : ''}${count.toLocaleString('en-US')}`;
  return boundedHeadline(
    t('voice.result.headline', {
      count: countText,
      noun: analystNounFor(keys),
      scope: result?.scopeLabel || '',
    }),
  );
}

function analystCard(result) {
  if (!result?.ok) return null;
  const display = result.display || {};
  const unanswered = Array.isArray(result.unanswered) ? result.unanswered : [];
  const provenance = result.feedProvenance || result.coverage?.feedProvenance;
  const sources = [
    ...new Set(
      [...(provenance?.layers || []), ...(result.coverage?.layersQueried || [])]
        .map((layer) =>
          String(layer?.source || '')
            .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    ),
  ].map((label) => ({ label }));
  return {
    display: {
      title: analystHeadline(result),
      // The precise scope, unless the title already says exactly that.
      lines: [
        display.scope !== result.scopeLabel ? display.scope : null,
        display.window,
      ].filter(Boolean),
      chips: [
        ...(result.feedState && result.feedState !== 'nominal'
          ? [{ label: result.feedState }]
          : []),
        ...(result.partial ? [{ label: t('voice.result.partialChip') }] : []),
      ],
      // Coverage qualifications lead the feed detail. The bounded card groups
      // overflow in its existing Notes disclosure rather than dropping them.
      preserveNotes: true,
      notes: [
        ...notesOf(result.coverage?.note, display.caveat),
        ...(unanswered.length
          ? [
              t('voice.result.notAnswered', {
                layers: unanswered.join(t('voice.speech.listSeparator')),
              }),
            ]
          : []),
      ],
      sources,
    },
    referents: Array.isArray(result.items) ? result.items : [],
    resultSet: true,
  };
}

const ADAPTERS = Object.freeze({
  analyst_query: analystCard,
});

/**
 * What the card shows for one result, or null when it shows nothing (a
 * silent lookup, a refusal, a cancelled call).
 * @param {string} name Tool name.
 * @param {object} result Tool result as the model received it.
 * @param {object} [args] Tool arguments.
 * @returns {{display: object, referents: Array<object>, resultSet?: boolean}|null}
 *   `resultSet` marks a fresh answer set that replaces the numbered list
 *   even when empty.
 */
export function presentResult(name, result, args = {}) {
  if (!result || typeof result !== 'object' || result.cancelled) return null;
  if (result.schedule === 'silent') return null;
  const adapter = ADAPTERS[name];
  if (adapter) {
    try {
      const card = adapter(result, args || {});
      if (card?.display?.title) return card;
    } catch {
      /* Presentation never breaks a result. */
    }
    return null;
  }
  if (!result.display?.title) return null;
  return {
    display: result.display,
    referents: Array.isArray(result.referents) ? result.referents : [],
  };
}
