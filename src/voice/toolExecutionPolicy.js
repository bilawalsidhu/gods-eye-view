import { readLayerLifecycleSummary } from './layerSummary.js';
import {
  responseInstructionForToolResult,
  shouldStopVoiceAfterRadioTool,
} from './realtimeProtocol.js';

export const VOICE_TOOL_FAILURE_TEXT_LIMIT = 512;

function projectFailureText(text) {
  const redacted = text
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[Redacted]@')
    .replace(/\b(?:sk-(?:proj-)?|ek_)[A-Za-z0-9_-]{8,}/g, '[Redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[Redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;<>]+/gi, '$1 [Redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[Redacted]',
    )
    .replace(
      /\b((?:[A-Za-z0-9]+[_-])*(?:api[ _-]?key|client[ _-]?secret|access[ _-]?token|refresh[ _-]?token|token|password|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1[Redacted]',
    );
  return redacted.length > VOICE_TOOL_FAILURE_TEXT_LIMIT
    ? `${redacted.slice(0, VOICE_TOOL_FAILURE_TEXT_LIMIT - 1)}…`
    : redacted;
}

/** Bound failure prose at provider output; keep useful reasons as inert data. */
export function projectVoiceToolResultForModel(result) {
  if (!result || typeof result !== 'object' || result.ok !== false)
    return result;
  const projected = { ...result };
  for (const key of ['error', 'say'])
    if (typeof result[key] === 'string')
      projected[key] = projectFailureText(result[key]);
  return projected;
}

/** Shared application authority; provider adapters retain transport ownership. */
export function classifyVoiceTool(name, args = {}) {
  const radioControl = name === 'control_radio';
  const radioVisibility =
    name === 'set_layer_visibility' &&
    String(args.layerId || '')
      .trim()
      .toLowerCase() === 'radio';
  const radioAction = radioControl
    ? String(args.action || '')
        .trim()
        .toLowerCase()
    : null;
  const authorityDomain =
    radioVisibility || ['enable', 'disable'].includes(radioAction)
      ? 'visibility'
      : radioAction === 'status'
        ? 'query'
        : radioControl
          ? 'playback'
          : null;
  const stronger =
    (radioControl && ['disable', 'pause', 'stop'].includes(radioAction)) ||
    (radioVisibility && args.enabled === false);
  return {
    radioControl,
    radioVisibility,
    radioAction,
    authorityDomain,
    stronger,
    abortScope:
      radioAction === 'disable' || radioVisibility ? 'all' : 'playback',
  };
}

/** Prepared playback hands off only after confirmation and playback readiness. */
export function shouldStopVoiceAfterToolResult(result) {
  return Boolean(
    shouldStopVoiceAfterRadioTool(result) &&
    !result.radioPlaybackRequested &&
    !result.radioPlaybackSuppressed,
  );
}

/** Read after stronger authority commits, including failure/abort envelopes. */
export function reconcileRadioToolResult(
  result,
  { dataManager, radioLayer, suppressPlayback = false } = {},
) {
  const radioResult =
    result?.action === 'control_radio' ||
    result?.tool === 'control_radio' ||
    ((result?.action === 'set_layer_visibility' ||
      result?.tool === 'set_layer_visibility') &&
      String(result.layerId || '')
        .trim()
        .toLowerCase() === 'radio');
  if (!radioResult) return result;
  let state;
  try {
    state = radioLayer?.getUIState?.() || {};
  } catch {
    state = {};
  }
  const lifecycle = readLayerLifecycleSummary(dataManager, 'radio', {
    fallbackEnabled: state.enabled ?? result.enabled,
  });
  return {
    ...result,
    ...lifecycle,
    audioState: state.audioState || result.audioState || 'stopped',
    ...(result.radioAction === 'pause' && lifecycle.enabled === false
      ? { changed: false }
      : {}),
    ...(suppressPlayback && result.ok && result.radioPlaybackRequested
      ? { radioPlaybackRequested: false, radioPlaybackSuppressed: true }
      : {}),
  };
}

/** Guidance is authored code; provider/lookup text remains inert result data. */
export function toolResultGuidance(result) {
  if (!result || typeof result !== 'object')
    return responseInstructionForToolResult(null);
  // Only bounded authored direction values enter instructions. Error/say
  // remain in the raw result; the formatter refers to them as inert data.
  return responseInstructionForToolResult({
    ...result,
    direction: ['in', 'out'].includes(result.direction)
      ? result.direction
      : 'as requested',
  });
}
