import {
  readVoiceProviderTextState,
  normalizeProviderText,
  readVoiceProviderFragmentMatchText,
  hasVoiceProviderExclusionWord,
} from './providerIntent.js';

const MAX_CANDIDATES = 256;
const MAX_SEGMENTS = 64;

/**
 * Full-run, restriction-only joins for attributed finalized speech segments.
 * Every junction may fall between or inside words. The parser owns both
 * completion and retention grammar; no suffix windows or cross-onset carry.
 * `viable` arbitrary-target forms retain joins without holding ordinary tools.
 */
export function createProviderFragmentTracker() {
  let candidates = [];
  let segments = 0;
  let overflow = false;
  let state = 'none';
  let excluded = false;
  const cache = new Map();
  return {
    append(segment) {
      if (typeof segment !== 'string') return state;
      if (state === 'input-limit') return state;
      const { text: normalized, overflow: inputOverflow } =
        readVoiceProviderTextState(segment);
      if (inputOverflow) {
        candidates = [];
        cache.clear();
        state = 'input-limit';
        return state;
      }
      if (!normalized) return state;
      if (++segments > MAX_SEGMENTS) overflow = true;
      excluded ||= hasVoiceProviderExclusionWord(segment);
      if (excluded) {
        candidates = [];
        state = overflow ? 'prefix' : 'none';
        return state;
      }
      const next = new Map();
      const consider = (raw) => {
        const text = normalizeProviderText(raw);
        if (!text || next.has(text)) return;
        let match = cache.get(text);
        if (!match) {
          match = readVoiceProviderFragmentMatchText(text);
          if (cache.size >= 512) cache.clear();
          cache.set(text, match);
        }
        if (!match.request && !match.viable) return;
        if (next.size >= MAX_CANDIDATES) {
          overflow = true;
          return;
        }
        next.set(text, match);
      };
      if (segments === 1) consider(normalized);
      else
        for (const candidate of candidates) {
          consider(`${candidate} ${normalized}`);
          consider(`${candidate}${normalized}`);
        }
      candidates = [...next.keys()];
      state = [...next.values()].some((match) => match.request)
        ? 'request'
        : overflow || [...next.values()].some((match) => match.prefix)
          ? 'prefix'
          : 'none';
      return state;
    },
    state: () => state,
    // Bounded state is visible for focused resource-bound regression checks.
    size: () => candidates.length,
  };
}
