import { readVoiceUserTurnText } from './userTurnIntent.js';
import { voiceProviderGuidance } from './providerCapabilities.js';
export { VOICE_PROVIDER_GUIDANCE } from './providerCapabilities.js';

// These finite command forms are shared by complete and incomplete matching.
// A prefix has only lexical meaning; it does not establish input ownership.
const choose = (...alternatives) => ({ alternatives });
const phrase = (...parts) => ({ parts });
const optional = (part) => choose('', part);
const provider = {
  alternatives: [
    'openai',
    'open ai',
    'gemini',
    'claude',
    'anthropic',
    'chatgpt',
    'chat gpt',
    'gpt',
    'grok',
    'copilot',
    'alexa',
    'siri',
    'elevenlabs',
    'eleven labs',
    'deepseek',
    'llama',
    'perplexity',
  ],
  captureProvider: true,
};
const polite = optional(
  choose(
    phrase(
      'please',
      optional(','),
      ' ',
      optional(phrase(choose('can', 'could', 'would'), ' you ')),
    ),
    phrase(choose('can', 'could', 'would'), ' you', optional(' please'), ' '),
  ),
);
const suffix = optional(phrase(optional(','), ' please'));
const switchOrChange = choose('switch', 'change');
const ownedArticle = optional(choose('the ', 'my '));
const providers = choose('provider', 'providers');
const voiceOrProvider = choose(
  phrase('voice', optional(phrase(' ', providers))),
  providers,
);
const openTarget = { openTarget: true };
const NOT_A_TARGET =
  /\b(?:and|or|but|if|unless|when|then|not|never|maybe|explain|tell|say|quote)\b/;

/** A fused guess must not erase an explicit word in the canonical input. */
export function hasVoiceProviderExclusionWord(input) {
  return typeof input === 'string' && NOT_A_TARGET.test(input.toLowerCase());
}
const TARGET = /^[a-z0-9][a-z0-9-]*(?: [a-z0-9-]+){0,2}$/;
export const MAX_PROVIDER_TEXT_LENGTH = 500;
const commands = [
  {
    request: 'provider',
    body: phrase(
      choose('choose', 'switch', 'change', 'select'),
      ' ',
      optional(choose('the ', 'my ', 'a ')),
      optional('voice '),
      providers,
    ),
  },
  {
    body: phrase(
      'use ',
      provider,
      optional(
        choose(' for voice', phrase(' as ', ownedArticle, 'voice provider')),
      ),
    ),
  },
  {
    body: phrase(switchOrChange, ' ', choose('to', 'over to'), ' ', provider),
  },
  {
    body: phrase(
      switchOrChange,
      ' ',
      optional(phrase(ownedArticle, optional('voice '), providers, ' ')),
      'from ',
      provider,
      ' to ',
      provider,
    ),
  },
  {
    body: phrase(
      switchOrChange,
      ' ',
      ownedArticle,
      voiceOrProvider,
      ' ',
      choose('to', 'over to'),
      ' ',
      provider,
    ),
  },
  {
    body: phrase(
      'set ',
      ownedArticle,
      choose(phrase('voice', optional(' provider')), 'provider'),
      optional(' to'),
      ' ',
      provider,
    ),
  },
  ...['set', 'select'].map((verb) => ({
    body: phrase(verb, ' ', provider, ' as ', ownedArticle, 'voice provider'),
  })),
  {
    body: phrase('make ', provider, ' ', ownedArticle, 'voice provider'),
  },
  // These explicit forms share their target slots with fragment retention.
  // Arbitrary targets are restrictive only once the full command is present.
  ...['use', 'set', 'select'].map((verb) => ({
    open: true,
    body: phrase(verb, ' ', openTarget, ' as ', ownedArticle, 'voice provider'),
  })),
  {
    open: true,
    body: phrase('make ', openTarget, ' ', ownedArticle, 'voice provider'),
  },
  {
    open: true,
    body: phrase(
      switchOrChange,
      ' ',
      ownedArticle,
      'voice ',
      providers,
      ' ',
      choose('to', 'over to'),
      ' ',
      openTarget,
    ),
  },
  {
    open: true,
    body: phrase(
      'set ',
      ownedArticle,
      'voice provider',
      choose(' to', ''),
      ' ',
      openTarget,
    ),
  },
].map(({ body, request, open }) => ({
  open,
  grammar: phrase(polite, body, suffix),
  request,
}));

/** Classify the shared bound without retaining oversized normalized text. */
export function readVoiceProviderTextState(input) {
  if (typeof input !== 'string' || !input)
    return { text: undefined, overflow: false };
  const text = input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+(?=\s|$)/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  const overflow = text.length > MAX_PROVIDER_TEXT_LENGTH;
  return { text: !overflow && text ? text : undefined, overflow };
}

/** Normalize before applying the shared 500-character grammar bound. */
export function normalizeProviderText(input) {
  return readVoiceProviderTextState(input).text;
}

function matchCommandPart(part, text, state, result) {
  if (part.openTarget) {
    const tail = text.slice(state.position);
    const matches = [];
    for (let length = 1; length <= tail.length; length++) {
      const target = tail.slice(0, length);
      if (TARGET.test(target) && !NOT_A_TARGET.test(target))
        matches.push({
          ...state,
          position: state.position + length,
          provider: target.replace(/ /g, ''),
        });
    }
    // The last target word may still grow: `and` can become `andy`.
    const completeWords = tail.split(' ').slice(0, -1).join(' ');
    if (!tail || (TARGET.test(tail) && !NOT_A_TARGET.test(completeWords)))
      result.prefix = true;
    return matches;
  }
  if (typeof part === 'string') {
    if (text.startsWith(part, state.position))
      return [{ ...state, position: state.position + part.length }];
    if (part.startsWith(text.slice(state.position))) result.prefix = true;
    return [];
  }
  if (part.alternatives) {
    return part.alternatives.flatMap((alternative) =>
      matchCommandPart(alternative, text, state, result).map((matched) =>
        part.captureProvider
          ? { ...matched, provider: alternative.replace(/ /g, '') }
          : matched,
      ),
    );
  }
  return part.parts.reduce(
    (states, child) =>
      states.flatMap((current) =>
        matchCommandPart(child, text, current, result),
      ),
    [state],
  );
}

function matchProviderRequest(text) {
  const result = { request: undefined, prefix: false, viable: false };
  for (const command of commands) {
    const candidate = { prefix: false };
    const states = matchCommandPart(
      command.grammar,
      text,
      { position: 0 },
      candidate,
    );
    result.viable ||= candidate.prefix;
    if (!command.open) result.prefix ||= candidate.prefix;
    const complete = states.find((state) => state.position === text.length);
    if (complete) {
      result.request = command.request ?? complete.provider;
      break;
    }
  }
  return result;
}

/** Provider policy consumes only current, first-party input provenance. */
export function readVoiceProviderRequest(userTurn) {
  return readVoiceProviderRequestText(readVoiceUserTurnText(userTurn));
}

/** A restrictive result needs authentic current input, never guessed intent. */
export function readVoiceRequestRestriction(userTurn) {
  const { text, overflow } = readVoiceProviderTextState(
    readVoiceUserTurnText(userTurn),
  );
  if (overflow) return { kind: 'input-limit' };
  const request = text ? matchProviderRequest(text).request : undefined;
  return request ? { kind: 'provider', request } : null;
}

/** Parse one direct first-party command. Callers own the input provenance. */
export function readVoiceProviderRequestText(input) {
  const text = normalizeProviderText(input);
  return text ? matchProviderRequest(text).request : undefined;
}

/** Full-input lexical classification; viability grants no action authority. */
export function readVoiceProviderFragmentMatchText(input) {
  const text = normalizeProviderText(input);
  return text
    ? matchProviderRequest(text)
    : { request: undefined, prefix: false, viable: false };
}

/** A lexical hold candidate only; callers must independently own the speech. */
export function isVoiceProviderRequestPrefixText(input) {
  const text = normalizeProviderText(input);
  if (!text) return false;
  const result = matchProviderRequest(text);
  return !result.request && result.prefix;
}

/** Return the non-mutating result shared by every model tool surface. */
export function providerRequestGuidanceResult(action, capabilities) {
  const guidance = voiceProviderGuidance(capabilities);
  return {
    ok: false,
    action,
    changed: false,
    providerRequestBlocked: true,
    error: guidance,
    say: guidance,
    providerDropdown: capabilities?.providerDropdown === true,
  };
}

/** Oversized input is unverified, rather than an inferred provider request. */
export function voiceRequestRestrictionResult(
  action,
  restriction,
  capabilities,
) {
  if (restriction?.kind === 'provider')
    return providerRequestGuidanceResult(action, capabilities);
  if (restriction?.kind !== 'input-limit') return null;
  const guidance =
    'I couldn’t verify this command because it is too long. Please shorten the command and try again.';
  return {
    ok: false,
    action,
    changed: false,
    voiceInputTooLong: true,
    voiceIntentUnverified: true,
    error: guidance,
    say: guidance,
  };
}
