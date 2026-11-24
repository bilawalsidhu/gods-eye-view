import {
  SNAPSHOT_FEED_STATES,
  feedProvenanceEnvelope,
  layerSnapshots,
  provenanceTag,
} from './data/layerSnapshot.js';
import { DEFAULT_LOCALE, normalizeLocale } from './i18n/locale.js';

export const HUD_SUMMARY_UNCONFIGURED_CODE = 'OPENAI_NOT_CONFIGURED';

/**
 * Describe the optional HUD summary capability without turning a deliberately
 * keyless boot into an HTTP failure.
 *
 * @param {unknown} apiKey - Candidate server-side OpenAI credential.
 * @returns {{ statusCode: 200, payload: { configured: false, code: string, error: null, summary: null } }|null}
 *   A graceful unconfigured response, or null when the provider is configured.
 */
export function keylessHudSummaryResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
      error: null,
      summary: null,
    },
  };
}

/** Return true only for the deliberate, successful no-key capability response. */
export function isHudSummaryUnconfigured(status, data) {
  const keys =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data)
      : [];
  return (
    keys.length === 4 &&
    status === 200 &&
    data?.configured === false &&
    data?.code === HUD_SUMMARY_UNCONFIGURED_CODE &&
    data?.error === null &&
    data?.summary === null
  );
}

/**
 * HUD summary model instructions. The five words may only describe supplied
 * labels; the feed state comes back as its own canonical field, so the check
 * does not depend on the summary's language or wording.
 */
export const HUD_SUMMARY_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, enabled-layer labels, and feedProvenance.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'In the summary, name layers only as in enabledLayerLabels; never copy layer names or state words from feedProvenance into it.',
  'Set feedState to feedProvenance.overall exactly as given, or null when it is null.',
  'When feedProvenance.overall is null, say nothing about feeds or layers, present or missing.',
  'If feedProvenance.overall is partial, do not present the coverage as complete; if it is any other state but nominal, do not present the view as live or healthy.',
  'Do not infer from coordinates or invent a place or feed state.',
  // "Exactly five words" made a small model pad a short view with words like
  // "no data" or "unavailable".
  'The summary has at most five words, with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

/** Longest summary, in characters, for a script written without spaces. */
export const HUD_SUMMARY_MAX_UNSPACED_CHARS = 20;

/** Longest summary, in characters; the cut falls between words. */
export const HUD_SUMMARY_MAX_CHARS = 80;

/** Responses API structured output: the summary plus the canonical state. */
export const HUD_SUMMARY_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  name: 'hud_summary',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      // Nullable rather than a `none` token, which the model wrote into the
      // summary of a view without layers.
      feedState: {
        anyOf: [
          { type: 'string', enum: [...SNAPSHOT_FEED_STATES] },
          { type: 'null' },
        ],
      },
    },
    required: ['summary', 'feedState'],
    additionalProperties: false,
  },
});

/** A shipped locale for the request, English when missing or unsupported. */
export function hudSummaryLocale(value) {
  return normalizeLocale(value) || DEFAULT_LOCALE;
}

// Names Intl.DisplayNames gets wrong for the shipped catalogs: pt is the
// Brazilian variant, and zh-Hant is the zh-CN wording in Traditional script.
const SUMMARY_LANGUAGES = Object.freeze({
  pt: 'Brazilian Portuguese',
  'zh-CN': 'Simplified Chinese',
  'zh-Hant': 'Chinese in Traditional characters (mainland wording)',
});

/** Scripts written without spaces, capped in characters instead of words. */
const UNSPACED_LOCALES = /^(?:ja|zh)(?:-|$)/;

/** Shipped locales not written in Latin letters. */
const NON_LATIN_LOCALES = /^(?:ar|ja|ru|uk|zh|he)(?:-|$)/;

/** Scripts whose letters extend a word; any other neighbour ends it. */
const WORD_SCRIPTS = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Arabic',
  'Hebrew',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
].map((script) => `\\p{Script=${script}}`);

/** Lower case, with punctuation and brackets as spaces: `Earthquakes 24h`. */
function flatWords(value) {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

const UNSPACED_WORD =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;

function wordScript(char) {
  return WORD_SCRIPTS.find((script) => new RegExp(script, 'u').test(char));
}

/**
 * Whether `word` stands on its own in `text`. Only a letter of the same
 * script extends it, so `stale` flush against kana or Han still counts.
 * Han and kana have no word edges: a word in them counts anywhere.
 * @param {string} text
 * @param {string} word
 * @returns {boolean}
 */
export function hasWord(text, word) {
  const haystack = flatWords(text);
  const needle = flatWords(word);
  if (!needle) return false;
  if (UNSPACED_WORD.test(needle)) return haystack.includes(needle);
  const chars = [...needle];
  const before = wordScript(chars[0]);
  const after = wordScript(chars.at(-1));
  // flatWords leaves no regex syntax in the needle.
  return new RegExp(
    `${before ? `(?<!${before})` : ''}${needle}${after ? `(?!${after})` : ''}`,
    'u',
  ).test(haystack);
}

/**
 * Whether a non-English summary carries what the HUD does not show: one of
 * `words` (feed-state ids, translated layers' English names and ids), or only
 * Latin letters in a language written in another script.
 * @param {string} summary The model's words.
 * @param {unknown} locale The request locale.
 * @param {string[]} [words] Words the summary must not carry.
 * @returns {boolean}
 */
export function hudSummaryHasEnglish(summary, locale, words = []) {
  const tag = hudSummaryLocale(locale);
  if (tag === DEFAULT_LOCALE) return false;
  const letters = String(summary || '').replace(/[^\p{L}]/gu, '');
  if (!hudSummaryIsLatin(tag) && !letters.replace(/\p{Script=Latin}/gu, ''))
    return true;
  return words.some((word) => hasWord(summary, word));
}

/** Whether the locale is written in Latin letters. */
export function hudSummaryIsLatin(locale) {
  return !NON_LATIN_LOCALES.test(hudSummaryLocale(locale));
}

export function hudSummaryIsUnspaced(locale) {
  return UNSPACED_LOCALES.test(hudSummaryLocale(locale));
}

/** The language a request's summary is written in, named in English. */
function summaryLanguage(tag) {
  if (SUMMARY_LANGUAGES[tag]) return SUMMARY_LANGUAGES[tag];
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
}

/**
 * @param {unknown} locale The `locale` the HUD sent.
 * @returns {string}
 */
export function hudSummaryInstructions(locale) {
  const tag = hudSummaryLocale(locale);
  if (tag === DEFAULT_LOCALE) return HUD_SUMMARY_INSTRUCTIONS;
  const language = summaryLanguage(tag);
  const length = hudSummaryIsUnspaced(tag)
    ? ` Instead of five words, write one phrase of at most ${HUD_SUMMARY_MAX_UNSPACED_CHARS} characters.`
    : '';
  return `${HUD_SUMMARY_INSTRUCTIONS} Write the summary in ${language} (${tag}), not English. Give places their usual names in that language and layers the names in enabledLayerLabels; feedState stays the English value.${length}`;
}

/**
 * The model input: the HUD context, led by the summary language when it is
 * not English. A small model follows the language far more reliably when it
 * is part of the input as well as the instructions.
 * @param {object} context The HUD summary context.
 * @returns {string}
 */
export function hudSummaryInput(context) {
  const tag = hudSummaryLocale(context?.locale);
  const json = JSON.stringify(context ?? {});
  if (tag === DEFAULT_LOCALE) return json;
  return `Summary language: ${summaryLanguage(tag)} (${tag}).\n${json}`;
}

/**
 * Stamp HUD summary context with the same layer snapshots voice tools use.
 * @param {Array<object>} [layers] `DataLayerManager.getAll()` rows.
 * @param {{ now?: number }} [options]
 * @returns {{
 *   enabledLayerLabels: string[],
 *   enabledLayers: Array<{id: string|null, name: string|null, feedState: string, source: string|null, count: number}>,
 *   feedProvenance: object,
 * }}
 */
export function hudSummaryLayerContext(layers = [], options) {
  const snapshots = layerSnapshots(layers, options).filter((s) => s.enabled);
  const envelope = feedProvenanceEnvelope(snapshots, options);
  return {
    enabledLayerLabels: snapshots.map((s) => s.name).filter(Boolean),
    enabledLayers: snapshots.map((s) => ({
      id: s.id,
      name: s.name,
      feedState: s.feedState,
      source: s.source,
      count: s.count,
    })),
    feedProvenance: envelope,
  };
}

/**
 * The warning for the HUD telemetry line when an enabled feed is not
 * nominal.
 * @param {Array<object>} [layers]
 * @param {{ now?: number }} [options]
 * @returns {{ state: string, names: string[] }|null}
 */
export function hudTelemetryProvenance(layers = [], options) {
  const snapshots = layerSnapshots(layers, options).filter((s) => s.enabled);
  return provenanceTag(feedProvenanceEnvelope(snapshots, options));
}
