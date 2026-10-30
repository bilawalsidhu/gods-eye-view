import {
  SNAPSHOT_FEED_STATES,
  feedProvenanceEnvelope,
  layerSnapshots,
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
  'Set feedState to feedProvenance.overall exactly as given, or none when it is null.',
  'If feedProvenance.overall is not nominal, the summary must not present the view as live or healthy.',
  'Do not infer from coordinates or invent a place or feed state.',
  'The summary is exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

/** feedState values the model may return; none stands for a null overall. */
export const HUD_SUMMARY_FEED_STATES = Object.freeze([
  ...SNAPSHOT_FEED_STATES,
  'none',
]);

/** Responses API structured output: the five words plus the canonical state. */
export const HUD_SUMMARY_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  name: 'hud_summary',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      feedState: { type: 'string', enum: [...HUD_SUMMARY_FEED_STATES] },
    },
    required: ['summary', 'feedState'],
    additionalProperties: false,
  },
});

/** A shipped locale for the request, English when missing or unsupported. */
export function hudSummaryLocale(value) {
  return normalizeLocale(value) || DEFAULT_LOCALE;
}

/** The language a request's summary is written in, named in English. */
function summaryLanguage(tag) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
}

/**
 * The instructions for one request: English as before, otherwise one more
 * sentence naming the language the five words are written in.
 * @param {unknown} locale The `locale` the HUD sent.
 * @returns {string}
 */
export function hudSummaryInstructions(locale) {
  const tag = hudSummaryLocale(locale);
  if (tag === DEFAULT_LOCALE) return HUD_SUMMARY_INSTRUCTIONS;
  const language = summaryLanguage(tag);
  return `${HUD_SUMMARY_INSTRUCTIONS} Write the summary in ${language} (${tag}), not English, giving places and layers their usual ${language} names; feedState stays the English value.`;
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
 * The feed state and up to two layer names of a provenance envelope that is
 * not nominal, or null. Values stay English (`state` is a feed-state id,
 * `names` are `layer.name`); the HUD translates them for display.
 * @param {{ overall?: string|null, layers?: Array<object> }|null} envelope
 * @returns {{ state: string, names: string[] }|null}
 */
export function provenanceTag(envelope) {
  const overall = envelope?.overall;
  if (!overall || overall === 'nominal' || overall === 'off') return null;
  const names = (envelope.layers || [])
    .filter(
      (s) => s.feedState && s.feedState !== 'nominal' && s.feedState !== 'off',
    )
    .map((s) => String(s.name || s.id || 'LAYER'))
    .slice(0, 2);
  return { state: overall, names };
}

/**
 * The feed-state tag for the HUD telemetry suffix when an enabled feed is not
 * nominal.
 * @param {Array<object>} [layers]
 * @param {{ now?: number }} [options]
 * @returns {{ state: string, names: string[] }|null}
 */
export function hudTelemetryProvenance(layers = [], options) {
  const snapshots = layerSnapshots(layers, options).filter((s) => s.enabled);
  return provenanceTag(feedProvenanceEnvelope(snapshots, options));
}

/**
 * Show an AI summary only when its canonical feedState is the HUD's own: a
 * view that is not nominal falls back on a missing or different state.
 * @param {{ feedState?: string|null }|null} response The proxy's reply.
 * @param {{ overall?: string|null }|null} provenance The context's envelope.
 * @returns {boolean}
 */
export function hudSummaryMatchesProvenance(response, provenance) {
  const state = provenance?.overall;
  if (!state || state === 'nominal' || state === 'off') return true;
  return response?.feedState === state;
}
