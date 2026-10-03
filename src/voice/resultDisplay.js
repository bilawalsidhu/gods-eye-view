/**
 * The one adapter from a tool result to what the voice card shows.
 *
 * Most tools carry a card-ready `display` ({title, lines, chips, notes,
 * sources}) from their speech builder. The analyst, area, imagery and OSM
 * tools instead return semantic fields the engine owns (count, complete,
 * scopeLabel, needsClarification, candidates, and a `display` of scope,
 * source, window and caveat). This module turns those into the card shape so
 * every result renders the same way, and names the numbered referents the
 * card lists (the referent registry reads the same answer, so "the second
 * one" always means the second row on screen).
 *
 * Pure: no DOM, no Cesium.
 * @module voice/resultDisplay
 */

import { analystHeadline, spokenLabel } from './speech.js';

/** Split "a; b" caveat text into separate notes. */
function notesOf(...values) {
  return values
    .flatMap((value) => String(value || '').split(/;\s*/))
    .map((text) => text.trim())
    .filter(Boolean);
}

/** Area levels in words. */
const LEVEL_WORDS = Object.freeze({
  admin1: 'state or province',
  admin2: 'county or district',
  district: 'neighbourhood',
  natural: 'natural region',
});

/** Candidate lines for a clarification: "1 · Punjab — state or province, India". */
function candidateLines(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate, i) => {
    const level = candidate?.level
      ? LEVEL_WORDS[candidate.level] || candidate.level
      : null;
    const detail = [level, candidate?.country].filter(Boolean).join(', ');
    return `${i + 1} · ${spokenLabel(candidate?.name || 'Unnamed', 40)}${detail ? ` — ${detail}` : ''}`;
  });
}

function clarification(result, subject) {
  if (!result?.needsClarification) return null;
  return {
    display: {
      title: `Which ${spokenLabel(subject || 'place', 40)}?`,
      lines: candidateLines(result.candidates),
    },
    referents: [],
  };
}

function analystCard(result, args = {}) {
  if (!result?.ok)
    return clarification(result, result?.query || args?.scope?.name);
  const display = result.display || {};
  const unanswered = Array.isArray(result.unanswered) ? result.unanswered : [];
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
        ...(result.partial ? [{ label: 'partial' }] : []),
      ],
      notes: [
        ...notesOf(display.caveat, result.coverage?.note),
        ...(unanswered.length
          ? [`Not answered: ${unanswered.join(', ')}`]
          : []),
      ],
    },
    referents: Array.isArray(result.items) ? result.items : [],
    resultSet: true,
  };
}

function areaCard(result, args = {}) {
  if (!result?.ok) return clarification(result, result?.query || args.query);
  const display = result.display || {};
  const km2 = Number(result.areaKm2);
  return {
    display: {
      title: `${spokenLabel(result.name || 'Area', 48)}${result.country ? `, ${spokenLabel(result.country, 24)}` : ''}`,
      lines: [
        Number.isFinite(km2) && km2 > 0
          ? `${km2.toLocaleString('en-US')} km²`
          : null,
        display.basis,
        display.parts,
        display.drawnParts,
        result.notDrawn ? `Not drawn: ${result.notDrawn}` : null,
      ].filter(Boolean),
      chips: [
        ...(result.approximate ? [{ label: 'approximate' }] : []),
        ...(result.partial ? [{ label: 'partial' }] : []),
      ],
      notes: notesOf(display.caveat),
      sources: display.source ? [{ label: display.source }] : [],
    },
    referents: [],
  };
}

const capitalized = (text) =>
  text
    ? `${String(text).charAt(0).toUpperCase()}${String(text).slice(1)}`
    : null;

function imageryCard(result) {
  if (!result?.ok) return null;
  const display = result.display || {};
  const shown = result.shown;
  const lines = shown
    ? [
        shown.cloudPct !== null && shown.cloudPct !== undefined
          ? `${shown.cloudPct}% cloud`
          : null,
        result.area ? `Over ${spokenLabel(result.area, 48)}` : null,
        `${result.count} of ${result.total} acquisitions match`,
        capitalized(display.window),
      ]
    : [
        `${result.total ?? 0} acquisitions searched`,
        capitalized(display.window),
      ];
  return {
    display: {
      title: shown
        ? `${spokenLabel(shown.source, 32)} · ${shown.date}`
        : 'No matching imagery',
      lines: lines.filter(Boolean),
      chips: shown && !shown.onMap ? [{ label: 'loading' }] : [],
      notes: notesOf(display.caveat),
    },
    referents: [],
  };
}

function osmCard(result) {
  if (!result?.ok) return null;
  const display = result.display || {};
  const count = Number(result.count);
  const counted = Number.isFinite(count)
    ? count.toLocaleString('en-US')
    : 'Unknown number of';
  const floor =
    result.countScope === 'bounding-box'
      ? 'About '
      : result.complete === false
        ? 'At least '
        : '';
  return {
    display: {
      title: `${floor}${counted} ${spokenLabel(result.kind || 'places', 32)}`,
      lines: [
        result.area ? `In ${spokenLabel(result.area, 48)}` : null,
        display.merged,
      ].filter(Boolean),
      notes: notesOf(display.caveat),
      sources: display.source ? [{ label: display.source }] : [],
    },
    referents: Array.isArray(result.referents) ? result.referents : [],
    resultSet: true,
  };
}

const ADAPTERS = Object.freeze({
  analyst_query: analystCard,
  resolve_area: areaCard,
  find_imagery: imageryCard,
  osm_query: osmCard,
});

/**
 * What the card shows for one result, or null when it shows nothing (a
 * silent lookup, a refusal without a question, a cancelled call).
 * @param {string} name Tool name.
 * @param {object} result Tool result as the model received it.
 * @param {object} [args] Tool arguments (names a clarification's subject).
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
