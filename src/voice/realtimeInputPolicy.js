export const PUSH_TO_TALK_HOLD_DELAY_MS = 500;

// The input meter is intentionally stricter than the assistant-output meter:
// microphones carry room tone even after browser noise suppression, whereas the
// incoming Realtime stream is already clean speech audio.
export const MICROPHONE_VISUALIZER_GATE = 0.12;

export const ASSISTANT_VISUALIZER_GATE = 0.04;

/**
 * Returns whether a keyboard event represents the hold-Space voice shortcut.
 * @param {KeyboardEvent|object|null} event
 * @returns {boolean}
 */
export function isPushToTalkKey(event) {
  return event?.code === 'Space' || event?.key === ' ';
}

export const SPACE_INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'a[href]',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]',
  '[tabindex]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
].join(', ');

/**
 * Returns whether Space began on the map surface reserved for push-to-talk.
 * Cesium gives its canvas `tabindex="0"` for camera input, which otherwise
 * makes the generic focus guard treat a map click like a button activation.
 */
export function isPushToTalkSurface(target) {
  if (target?.tagName?.toUpperCase?.() !== 'CANVAS') return false;
  if (target.id === 'world-overlay-canvas') return true;
  return Boolean(target.closest?.('#cesiumContainer'));
}

/** Returns whether a focused target owns Space for UI interaction. */
export function isInteractiveSpaceTarget(target) {
  if (!target) return false;
  if (isPushToTalkSurface(target)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest?.(SPACE_INTERACTIVE_SELECTOR));
}

/** Returns whether Space belongs to a text-entry surface. */
export function isEditingSpaceTarget(target) {
  if (!target) return false;
  if (target.isContentEditable || target.closest?.('[contenteditable]'))
    return true;
  if (
    target.closest?.(
      'textarea, [role="textbox"], [role="searchbox"], [role="spinbutton"]',
    )
  ) {
    return true;
  }
  const input = target.closest?.('input');
  if (!input) return false;
  const type = String(input.type || 'text').toLowerCase();
  return [
    'text',
    'search',
    'email',
    'url',
    'tel',
    'password',
    'number',
    'date',
    'datetime-local',
    'month',
    'week',
    'time',
  ].includes(type);
}

/** Protects text entry and modified shortcuts from push-to-talk arbitration. */
export function shouldHandlePushToTalkKeyDown(event) {
  if (!isPushToTalkKey(event) || event.defaultPrevented) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return false;
  return !isEditingSpaceTarget(event.target);
}

/**
 * Avoids a click/Space race that could stop an active voice session mid-turn.
 * @param {boolean} spaceKeyHeld
 * @returns {boolean}
 */
export function shouldIgnoreVoiceButtonClick(spaceKeyHeld) {
  return Boolean(spaceKeyHeld);
}

/**
 * Selects input or output frequency data for the active voice speaker.
 * @param {'idle'|'user'|'ai'} speaker
 * @param {{analyser: AnalyserNode|null, data: Uint8Array|null}} input
 * @param {{analyser: AnalyserNode|null, data: Uint8Array|null}} output
 * @returns {{analyser: AnalyserNode, data: Uint8Array}|null}
 */
export function selectVoiceVisualizerSignal(speaker, input, output) {
  const signal = speaker === 'ai' ? output : input;
  return signal?.analyser && signal?.data ? signal : null;
}

/**
 * Keeps analysing buffered assistant audio after the response-done control event.
 * @param {'idle'|'user'|'ai'} currentSpeaker
 * @param {'idle'|'user'|'ai'} nextSpeaker
 * @param {boolean} keepCurrent
 * @returns {'idle'|'user'|'ai'}
 */
export function resolveVoiceVisualizerSpeaker(
  currentSpeaker,
  nextSpeaker,
  keepCurrent = false,
) {
  if (keepCurrent && currentSpeaker === 'ai') return 'ai';
  return nextSpeaker === 'user' || nextSpeaker === 'ai' ? nextSpeaker : 'idle';
}

/**
 * Resolves the in-app help tray copy for the current push-to-talk state.
 * @param {boolean} pushToTalkMode
 * @param {boolean} pushToTalkKeyHeld
 * @returns {string}
 */
export function resolveVoiceControlHint(pushToTalkMode, pushToTalkKeyHeld) {
  return pushToTalkMode && pushToTalkKeyHeld
    ? 'Release Space to send'
    : 'Hold Space to speak · tap Space to activate focused controls';
}

/**
 * Removes low-level room noise before it can animate the voice meter.
 * @param {number} level - Normalized frequency energy (0–1).
 * @param {number} threshold - Noise-floor cutoff (0–1).
 * @returns {number} Re-normalized audible level (0–1).
 */
export function gateVoiceVisualizerLevel(level, threshold) {
  const cleanLevel = Number.isFinite(level)
    ? Math.min(1, Math.max(0, level))
    : 0;
  const cleanThreshold = Number.isFinite(threshold)
    ? Math.min(0.95, Math.max(0, threshold))
    : 0;
  if (cleanLevel <= cleanThreshold) return 0;
  return (cleanLevel - cleanThreshold) / (1 - cleanThreshold);
}

/**
 * Restores the CSS-owned standby baseline for every visualizer bar.
 * @param {Iterable<HTMLElement>|null|undefined} bars
 * @returns {void}
 */
export function resetVoiceVisualizerBars(bars) {
  if (!bars) return;
  for (const bar of bars) {
    bar.style.removeProperty('--audio-level');
    bar.style.removeProperty('--audio-opacity');
  }
}
