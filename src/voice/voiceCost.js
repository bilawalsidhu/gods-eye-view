// src/voice/voiceCost.js
/**
 * Voice model registry + Realtime session cost estimation.
 *
 * Pure module (no DOM, no network, no imports) so it can be shared by three
 * callers that cannot share anything else:
 *   1. the browser voice UI (`gevRealtime.js`) — live "~$0.42" readout + caps
 *   2. the dev-server token endpoint (`vite/proxies/realtime.js` → `/api/realtime/token`)
 *   3. unit tests (`voiceCost.test.mjs`)
 *
 * Two independent concerns live here:
 *   - MODEL TIERS: 'standard' (default) vs 'mini' (cheaper). The client asks
 *     for a tier by NAME; only this module maps a tier to an OpenAI model id,
 *     so an unknown/hostile tier string can never reach the OpenAI API.
 *   - SPEND GUARD: token usage → USD, with a soft warning and a hard cap.
 *
 * @module voice/voiceCost
 */

/* ------------------------------------------------------------------ *
 * MODEL REGISTRY
 * ------------------------------------------------------------------ */

/**
 * ⚠️ VERIFY AT RELEASE — MODEL IDS AND PRICES ARE EXTERNAL FACTS THAT DRIFT. ⚠️
 *
 * Both model ids and every rate below were read from OpenAI's own model +
 * pricing pages on 2026-08-18:
 *   - https://developers.openai.com/api/docs/models/gpt-realtime-2
 *   - https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
 *   - https://developers.openai.com/api/docs/pricing
 *
 * Cross-check at release time (a wrong rate silently mis-sizes the spend cap,
 * and a wrong model id fails the session at connect time):
 *   - `standard` MUST stay in sync with OPENAI_REALTIME_MODEL / the
 *     OPENAI_REALTIME_MODEL_DEFAULT constant in src/voice/realtimeSession.js.
 *   - `mini` has no in-repo history — it is new here. OpenAI publishes both
 *     `gpt-realtime-2.1-mini` (current, used below) and an older
 *     `gpt-realtime-mini`; there is NO `gpt-realtime-2-mini`. If the id ever
 *     moves, override it with OPENAI_REALTIME_MODEL_MINI rather than editing
 *     code — see .env.example.
 *
 * Rates are USD per 1,000,000 tokens (last verified against upstream
 * pricing: 2026-08-18).
 
/** @typedef {'standard'|'mini'} VoiceModelTier */

export const VOICE_MODELS = Object.freeze({
  standard: Object.freeze({
    tier: 'standard',
    id: 'gpt-realtime-2',
    label: 'STANDARD',
    /** USD per 1M tokens — gpt-realtime-2. */
    rates: Object.freeze({
      textInput: 4,
      textCachedInput: 0.4,
      textOutput: 24,
      audioInput: 32,
      audioCachedInput: 0.4,
      audioOutput: 64,
      imageInput: 5,
      imageCachedInput: 0.5,
    }),
  }),
  mini: Object.freeze({
    tier: 'mini',
    id: 'gpt-realtime-2.1-mini',
    label: 'MINI',
    /** USD per 1M tokens — gpt-realtime-2.1-mini (~3.2× cheaper on audio). */
    rates: Object.freeze({
      textInput: 0.6,
      textCachedInput: 0.06,
      textOutput: 2.4,
      audioInput: 10,
      audioCachedInput: 0.3,
      audioOutput: 20,
      imageInput: 0.8,
      imageCachedInput: 0.08,
    }),
  }),
});

/** The tier used when nothing (or nonsense) was requested. */
export const DEFAULT_VOICE_TIER = 'standard';

/** Every tier name the UI and the token endpoint accept. */
export const VOICE_TIERS = Object.freeze(Object.keys(VOICE_MODELS));

/**
 * Map a requested tier name to its model entry, falling back to `standard`.
 *
 * Deliberately total: an unknown, empty, non-string, or hostile value resolves
 * to the default rather than throwing, so a bad querystring degrades to the
 * normal session instead of breaking the mic. Callers that need to know a
 * fallback happened compare `entry.tier` to what they asked for.
 *
 * @param {unknown} tier - Tier name asked for by the UI or the token endpoint
 *   querystring; any value (including garbage) is accepted.
 * @returns {{tier: 'standard'|'mini', id: string, label: string, rates: object}}
 *   The registry entry for that tier, or the `standard` entry when `tier` is
 *   not a known name.
 */
export function resolveVoiceModel(tier) {
  // Own-property check, NOT `VOICE_MODELS[key] || default`: inherited keys
  // ('constructor', 'toString', '__proto__') resolve to truthy Object.prototype
  // members, which would sail past a `||` fallback and hand the token endpoint
  // a bogus entry whose `.id` is undefined.
  return isKnownVoiceTier(tier)
    ? VOICE_MODELS[String(tier).trim().toLowerCase()]
    : VOICE_MODELS[DEFAULT_VOICE_TIER];
}

/**
 * True only for a tier name this build knows (own properties only).
 * @param {unknown} tier - Candidate tier name; trimmed and lower-cased before
 *   the lookup, non-strings simply fail.
 * @returns {boolean} Whether the normalized name is an own key of
 *   `VOICE_MODELS` (never a prototype member such as `constructor`).
 */
export function isKnownVoiceTier(tier) {
  const key = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(VOICE_MODELS, key);
}

/**
 * The priciest known rate table, derived (not hardcoded) so it stays correct if
 * the registry gains a tier. Used as the conservative default whenever we do
 * not recognise the model a session is actually running on.
 *
 * @returns {{tier: 'standard'|'mini', id: string, label: string, rates: object}}
 *   The registry entry with the highest audio-output rate (the dominant cost
 *   in a speech-to-speech session).
 */
export function mostExpensiveVoiceModel() {
  // Rank by audio output — the dominant cost in a speech-to-speech session.
  return Object.values(VOICE_MODELS).reduce((worst, entry) =>
    entry.rates.audioOutput > worst.rates.audioOutput ? entry : worst
  );
}

/**
 * Resolve the rate table for the model a session is ACTUALLY running on.
 *
 * The tier a client asked for is only a request: `OPENAI_REALTIME_MODEL` /
 * `OPENAI_REALTIME_MODEL_MINI` can point a tier at any model id, so pricing by
 * tier would silently mis-meter (and overrun the cap) whenever an override is
 * set. Pricing by the id the server echoes back closes that gap.
 *
 * An unrecognised id bills at the most expensive known rates rather than
 * guessing cheap — under-metering is what lets a cap be overrun.
 *
 * @param {unknown} modelId - Model id the token endpoint echoed back for the
 *   live session (`OPENAI_REALTIME_MODEL` resolved); non-strings bill as
 *   unrecognised.
 * @returns {{tier: string, id: string, label: string, rates: object, recognized: boolean}}
 *   The matching registry entry with `recognized: true`, or the worst-case
 *   entry with `recognized: false` and `id` set to the value passed in.
 */
export function resolveVoiceModelById(modelId) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  for (const entry of Object.values(VOICE_MODELS)) {
    if (entry.id === id) return { ...entry, recognized: true };
  }
  const worst = mostExpensiveVoiceModel();
  return {
    ...worst,
    // Report the real model so the UI/diagnostics never claim the wrong one.
    id: id || worst.id,
    recognized: false,
  };
}

/* ------------------------------------------------------------------ *
 * SPEND GUARD CONFIG
 * ------------------------------------------------------------------ */

/**
 * Session spend thresholds, in USD. Deliberately generous — this is a runaway
 * guard (a hot mic left open, a feedback loop), not a budget.
 *
 * `warnUsd`: soft — one visual cue + one console line, session continues.
 * `capUsd`:  hard — the session is closed through the normal stop path.
 *
 * Either may be null/0/Infinity to disable that threshold.
 */
export const VOICE_COST_LIMITS = Object.freeze({
  warnUsd: 2,
  capUsd: 5,
});

/**
 * Serialized sentinel for a disabled threshold.
 *
 * A disabled threshold is Infinity in memory, but `JSON.stringify(Infinity)`
 * is `null`, which reads back as "absent" and silently restores the DEFAULT —
 * so a deliberately disabled cap would quietly re-arm on the next session.
 * Persist this string instead; `normalizeCostLimits` accepts it on the way in.
 */
export const VOICE_COST_LIMIT_OFF = 'off';

/**
 * Normalize a partial limits object against the defaults.
 *
 * Accepted "disabled" spellings: the `'off'` sentinel, Infinity, and a
 * 0/negative number. Absent/undefined/null and unparseable values fall back to
 * the default — a corrupt entry must never disarm the cap.
 *
 * @param {{warnUsd?: number|string, capUsd?: number|string}} [limits] - Raw
 *   thresholds as persisted (settings/localStorage) or supplied by the caller;
 *   each field is cleaned independently.
 * @returns {{warnUsd: number, capUsd: number}} Frozen limits; a disabled
 *   threshold is `Infinity`, an absent or unparseable one the default.
 */
export function normalizeCostLimits(limits) {
  const clean = (value, fallback) => {
    if (typeof value === 'string' && value.trim().toLowerCase() === VOICE_COST_LIMIT_OFF) {
      return Infinity;
    }
    if (value === Infinity) return Infinity;
    if (value === null || value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n > 0 ? n : Infinity; // 0/negative = "no threshold"
  };
  return Object.freeze({
    warnUsd: clean(limits?.warnUsd, VOICE_COST_LIMITS.warnUsd),
    capUsd: clean(limits?.capUsd, VOICE_COST_LIMITS.capUsd),
  });
}

/**
 * Convert limits to a JSON-safe shape that round-trips a disabled threshold.
 *
 * @param {{warnUsd?: number|string, capUsd?: number|string}} [limits] - Raw
 *   limits, exactly as `normalizeCostLimits` accepts them.
 * @returns {{warnUsd: number|string, capUsd: number|string}} Limits with every
 *   disabled threshold replaced by the `VOICE_COST_LIMIT_OFF` sentinel, so
 *   persistence keeps it disabled instead of re-arming the default.
 */
export function serializeCostLimits(limits) {
  const normalized = normalizeCostLimits(limits);
  const encode = (value) => (Number.isFinite(value) ? value : VOICE_COST_LIMIT_OFF);
  return {
    warnUsd: encode(normalized.warnUsd),
    capUsd: encode(normalized.capUsd),
  };
}

/* ------------------------------------------------------------------ *
 * USAGE → USD
 * ------------------------------------------------------------------ */

/**
 * Billable token buckets split out of one Realtime usage payload.
 *
 * `*Cached` buckets are the cached tokens already INCLUDED in the modality
 * totals; the `*In`/`*Out` buckets are the uncached remainder. The two
 * `*Total` fields carry the raw aggregates for reconciliation against the
 * source payload.
 *
 * @typedef {object} UsageTokenSplit
 * @property {number} textIn - Uncached text input tokens.
 * @property {number} audioIn - Uncached audio input tokens; absorbs any
 *   detail-vs-aggregate residual so nothing billed goes uncounted.
 * @property {number} imageIn - Uncached image input tokens.
 * @property {number} textCached - Cached text input tokens.
 * @property {number} audioCached - Cached audio input tokens.
 * @property {number} imageCached - Cached image input tokens.
 * @property {number} textOut - Text output tokens.
 * @property {number} audioOut - Audio output tokens; absorbs the output
 *   residual, and the whole output when no detail object is present.
 * @property {number} inputTotal - Raw `input_tokens` aggregate.
 * @property {number} outputTotal - Raw `output_tokens` aggregate.
 */

const nonNegative = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Split one Realtime `response.done` usage object into billable token buckets.
 *
 * The Realtime usage shape reports per-modality detail with CACHED TOKENS
 * INCLUDED in the modality totals, so uncached = modality − cached(modality).
 *
 * Older/partial payloads may omit `input_token_details` entirely. In that case
 * the whole input is attributed to AUDIO, the most expensive modality. That
 * deliberately over-estimates: for a spend cap the safe failure direction is
 * stopping early, never billing past the cap because a field was missing.
 *
 * The same policy applies to PARTIAL detail objects, which are the subtler
 * case: if `input_tokens` is 1000 but the only detail present is
 * `text_tokens: 100`, the other 900 tokens are real and billed upstream.
 * Counting only the named buckets would silently drop them and UNDER-meter —
 * exactly the direction that lets a cap be overrun. Any aggregate-minus-details
 * residual is therefore attributed to audio rates.
 *
 * @param {object|null|undefined} usage - `response.usage` from `response.done`.
 * @returns {UsageTokenSplit} Token buckets, all non-negative.
 */
export function splitUsageTokens(usage) {
  const inDetails = usage?.input_token_details || null;
  const outDetails = usage?.output_token_details || null;
  const cached = inDetails?.cached_tokens_details || null;

  const inputTotal = nonNegative(usage?.input_tokens);
  const outputTotal = nonNegative(usage?.output_tokens);

  let textIn;
  let audioIn;
  let imageIn;
  let textCached;
  let audioCached;
  let imageCached;

  if (inDetails) {
    textCached = nonNegative(cached?.text_tokens);
    audioCached = nonNegative(cached?.audio_tokens);
    imageCached = nonNegative(cached?.image_tokens);
    // When only an aggregate `cached_tokens` is present, attribute it to audio
    // (dominant modality in a voice session) so cache savings still register.
    if (!cached && nonNegative(inDetails.cached_tokens) > 0) {
      audioCached = Math.min(
        nonNegative(inDetails.cached_tokens),
        nonNegative(inDetails.audio_tokens)
      );
    }
    textIn = Math.max(0, nonNegative(inDetails.text_tokens) - textCached);
    audioIn = Math.max(0, nonNegative(inDetails.audio_tokens) - audioCached);
    imageIn = Math.max(0, nonNegative(inDetails.image_tokens) - imageCached);
  } else {
    // No detail — conservative all-audio attribution (see note above).
    textIn = 0;
    audioIn = inputTotal;
    imageIn = 0;
    textCached = 0;
    audioCached = 0;
    imageCached = 0;
  }

  // Residual = billed tokens the detail buckets did not account for. Attributed
  // to audio (priciest) so a partial payload over-estimates, never under.
  const inputResidual = Math.max(
    0,
    inputTotal - (textIn + audioIn + imageIn + textCached + audioCached + imageCached)
  );
  audioIn += inputResidual;

  const textOut = outDetails ? nonNegative(outDetails.text_tokens) : 0;
  let audioOut = outDetails ? nonNegative(outDetails.audio_tokens) : outputTotal;
  const outputResidual = Math.max(0, outputTotal - (textOut + audioOut));
  audioOut += outputResidual;

  return {
    textIn,
    audioIn,
    imageIn,
    textCached,
    audioCached,
    imageCached,
    textOut,
    audioOut,
    inputTotal,
    outputTotal,
  };
}

/**
 * Estimate the USD cost of one Realtime response's usage.
 *
 * @param {object|null|undefined} usage - `response.usage` from `response.done`.
 * @param {object} rates - a `VOICE_MODELS[tier].rates` table (USD per 1M).
 * @returns {number} USD, always finite and >= 0.
 */
export function estimateUsageCostUsd(usage, rates) {
  if (!usage || !rates) return 0;
  const t = splitUsageTokens(usage);
  const usd =
    (t.textIn * nonNegative(rates.textInput) +
      t.textCached * nonNegative(rates.textCachedInput) +
      t.textOut * nonNegative(rates.textOutput) +
      t.audioIn * nonNegative(rates.audioInput) +
      t.audioCached * nonNegative(rates.audioCachedInput) +
      t.audioOut * nonNegative(rates.audioOutput) +
      t.imageIn * nonNegative(rates.imageInput) +
      t.imageCached * nonNegative(rates.imageCachedInput)) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Format a running cost for the compact UI readout ("~$0.42").
 *
 * @param {number} usd - Cost in USD; non-finite or negative input clamps to 0.
 * @returns {string} Two-decimal display text; sub-cent non-zero totals read
 *   `~$0.01` rather than collapsing to `~$0.00`.
 */
export function formatCostUsd(usd) {
  const n = Number.isFinite(Number(usd)) ? Math.max(0, Number(usd)) : 0;
  if (n > 0 && n < 0.01) return '~$0.01';
  return `~$${n.toFixed(2)}`;
}

/* ------------------------------------------------------------------ *
 * SESSION COST TRACKER (state machine)
 * ------------------------------------------------------------------ */

/**
 * One immutable reading of the running session cost, returned by every
 * tracker method. The field-level policies (one-shot latches, worst-case
 * billing, incomplete accounting) are documented on the `snapshot` literal
 * inside `createVoiceCostTracker`.
 *
 * @typedef {object} VoiceCostSnapshot
 * @property {'standard'|'mini'} tier - Tier the session was priced from.
 * @property {string} modelId - Model id actually in use.
 * @property {boolean} ratesRecognized - False when the model id was unknown
 *   and billing fell back to the worst-case rate table.
 * @property {number} totalUsd - Running USD estimate for the session.
 * @property {number} responses - Billed responses folded into `totalUsd`.
 * @property {number} warnUsd - Effective soft threshold, Infinity when disabled.
 * @property {number} capUsd - Effective hard threshold, Infinity when disabled.
 * @property {'ok'|'warn'|'cap'} level - Highest threshold crossed so far.
 * @property {boolean} warnCrossed - True only on the single record() that
 *   crossed the soft threshold.
 * @property {boolean} capCrossed - True only on the single record() that
 *   crossed the hard cap.
 * @property {boolean} capReached - True once the cap is latched; the session
 *   must be stopped.
 * @property {boolean} incomplete - True when a billed response never reported
 *   usage, so the estimate is partial.
 * @property {string} display - Compact chip text (`~$0.42*`); the `*` is a
 *   see-note mark, never a direction claim.
 * @property {string|null} note - Prose for the tooltip, null when the
 *   accounting is complete.
 */

/**
 * Tracker API for one voice session's spend guard.
 *
 * @typedef {object} VoiceCostTracker
 * @property {{tier: string, id: string, label: string, rates: object,
 *   recognized: boolean}} model - Frozen pricing for the bound model.
 * @property {{warnUsd: number, capUsd: number}} limits - Effective thresholds
 *   after normalization.
 * @property {Function} record - Folds one response's usage into the total and
 *   re-evaluates both thresholds.
 * @property {Function} state - Reads the current state without folding in
 *   new usage.
 * @property {Function} markIncomplete - Records that a billed response will
 *   never report its usage.
 * @property {Function} reset - Zeroes the totals for a new session while
 *   keeping the same model binding and limits.
 */

/**
 * Accumulate per-response usage into a running session cost and latch the two
 * threshold crossings.
 *
 * `response.done` usage is PER RESPONSE, not cumulative, so responses sum.
 *
 * Both crossings are independent one-shot latches: each fires on the first
 * `record()` that carries the total at or past its threshold and never again,
 * so one warning line is logged and the cap stop is requested exactly once —
 * even though `record()` keeps being called while the session tears down.
 *
 * The model binding is fixed at construction and never changes: a tracker
 * belongs to exactly one session, priced against the model that session is
 * actually running on. Pass `modelId` (the id the server echoed back) when it
 * is known — it outranks `tier`, because an env override can point a tier at a
 * different model. `tier` alone is only used before a session exists.
 *
 * @param {{tier?: string, modelId?: string,
 *          limits?: {warnUsd?: number, capUsd?: number}}} [options] - Session
 *   pricing and thresholds: `modelId` (server-echoed) outranks `tier`, and
 *   `limits` is passed through `normalizeCostLimits` on the way in.
 * @returns {VoiceCostTracker} Tracker bound to exactly one session; every
 *   method returns a fresh `VoiceCostSnapshot`.
 */
export function createVoiceCostTracker(options = {}) {
  const model = options.modelId
    ? resolveVoiceModelById(options.modelId)
    : { ...resolveVoiceModel(options.tier), recognized: true };
  const limits = normalizeCostLimits(options.limits);

  let totalUsd = 0;
  let responses = 0;
  let warned = false;
  let capped = false;
  let incomplete = false;

  const snapshot = (warnCrossed = false, capCrossed = false) => ({
    tier: model.tier,
    modelId: model.id,
    /** False when the model was unrecognised and billed at worst-case rates. */
    ratesRecognized: model.recognized !== false,
    totalUsd,
    responses,
    warnUsd: limits.warnUsd,
    capUsd: limits.capUsd,
    /** 'ok' | 'warn' | 'cap' — monotonic; never steps back down. */
    level: capped ? 'cap' : warned ? 'warn' : 'ok',
    /** True only on the single record() that crossed the soft threshold. */
    warnCrossed,
    /** True only on the single record() that crossed the hard cap. */
    capCrossed,
    /** True once the cap is latched — the session must be stopped. */
    capReached: capped,
    /**
     * True when at least one billed response never reported usage (the session
     * was torn down mid-response), so the accounting is PARTIAL.
     *
     * Deliberately not called a lower bound: the estimate can also run high
     * (residuals and unknown models bill at worst-case rates, and sub-cent
     * totals round up), so the total is neither a guaranteed floor nor a
     * guaranteed ceiling — just incomplete. We have no token telemetry for an
     * unfinished response and do not invent one.
     */
    incomplete,
    /** Compact chip text. The '*' is a see-note mark, NOT a direction claim. */
    display: formatCostUsd(totalUsd) + (incomplete ? '*' : ''),
    /** Prose for the tooltip; null when the accounting is complete. */
    note: incomplete
      ? 'Estimate is incomplete — a response was still in flight when the session ended, so its usage was never reported.'
      : null,
  });

  return {
    model,
    limits,
    /**
     * Fold one response's usage into the session total.
     * @param {object} usage - `response.usage`
     * @returns {VoiceCostSnapshot} Post-fold state, with `warnCrossed` /
     *   `capCrossed` set on the one record that crosses each threshold.
     */
    record(usage) {
      const usd = estimateUsageCostUsd(usage, model.rates);
      if (usd > 0) {
        totalUsd += usd;
        responses += 1;
      }
      let warnCrossed = false;
      let capCrossed = false;
      if (!warned && totalUsd >= limits.warnUsd) {
        warned = true;
        warnCrossed = true;
      }
      if (!capped && totalUsd >= limits.capUsd) {
        capped = true;
        capCrossed = true;
      }
      return snapshot(warnCrossed, capCrossed);
    },
    /**
     * Current state without folding in new usage.
     * @returns {VoiceCostSnapshot} The latched state as of the last record().
     */
    state: () => snapshot(),
    /**
     * Record that a billed response will never report its usage (torn down
     * mid-response). Flags the accounting as incomplete rather than
     * fabricating a token count for it.
     *
     * @returns {VoiceCostSnapshot} State with `incomplete` latched on; the
     *   total is unchanged.
     */
    markIncomplete() {
      incomplete = true;
      return snapshot();
    },
    /**
     * Reset for a new session (same model/limits).
     * @returns {VoiceCostSnapshot} Zeroed state; `incomplete` is cleared too.
     */
    reset() {
      totalUsd = 0;
      responses = 0;
      warned = false;
      capped = false;
      incomplete = false;
      return snapshot();
    },
  };
}
