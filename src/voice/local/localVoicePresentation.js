import {
  LLM_MODELS,
  STT_MODELS,
  TTS_ENGINES,
  formatBytes,
} from './modelCatalog.js';

const BUSY_PHASES = new Set(['checking', 'loading', 'preparing']);

/** Shown in the tray until natural voice first starts. */
export const NATURAL_VOICE_NOTICE =
  'Natural voice downloads an open-source speech component (GPL) to this browser.';

/** Short chip label for a model, e.g. "12B" for "Gemma 4 12B". */
export function shortModelLabel(model) {
  if (!model) return '--';
  if (model.short) return model.short;
  const match = /Gemma 4 (.+)$/.exec(model.label || '');
  return (match ? match[1] : model.label || model.id).toUpperCase();
}

function progressLine(progress, models) {
  const entries = Object.entries(progress || {}).filter(([, event]) => event);
  if (!entries.length) return null;
  const active =
    entries.find(
      ([, event]) =>
        event.phase !== 'compile' && event.total && event.loaded < event.total,
    ) ||
    entries.find(([, event]) => event.phase === 'compile') ||
    entries[0];
  const [key, event] = active;
  const verb =
    event.phase === 'cache'
      ? 'LOADING'
      : event.phase === 'compile'
        ? 'COMPILING'
        : 'DOWNLOADING';
  const name =
    key === 'llm'
      ? models.llm?.label || 'model'
      : key === 'stt'
        ? models.stt?.label || 'speech recognition'
        : 'natural voice';
  const percent =
    event.total > 0
      ? Math.round(Math.min(1, event.loaded / event.total) * 100)
      : null;
  const amount =
    event.total > 0 && event.phase !== 'compile'
      ? ` · ${formatBytes(event.loaded)} / ${formatBytes(event.total)}`
      : '';
  return { label: `${verb} ${name.toUpperCase()}${amount}`, percent };
}

/**
 * Derives the voice tray's controls from one provider snapshot.
 * @param {object} state Local voice store snapshot.
 * @param {{llmModels?: object[], sttModels?: object[]}} [catalog]
 */
export function localVoiceTrayView(
  state,
  {
    llmModels = LLM_MODELS,
    sttModels = STT_MODELS,
    ttsEngines = TTS_ENGINES,
  } = {},
) {
  const busy = BUSY_PHASES.has(state.phase);
  const llm = llmModels.find((model) => model.id === state.llm) || null;
  const stt = sttModels.find((model) => model.id === state.stt) || null;
  const unsupported = state.support && state.support.ok === false;
  const progress = busy ? progressLine(state.progress, { llm, stt }) : null;
  let status;
  if (unsupported) status = state.support.reason;
  else if (state.phase === 'error') status = state.message || 'Voice failed';
  else if (state.phase === 'checking') status = 'CHECKING THIS DEVICE';
  else if (state.phase === 'preparing') status = 'PREPARING MODEL';
  else if (state.phase === 'loading') status = 'LOADING MODELS';
  else if (state.phase === 'ready')
    status = `READY · ${shortModelLabel(llm)} · HOLD SPACE`;
  else status = 'OFF · FIRST START DOWNLOADS THE MODEL';
  const pending =
    state.phase === 'ready' &&
    ((state.loadedLlm && state.loadedLlm !== state.llm) ||
      (state.loadedStt && state.loadedStt !== state.stt) ||
      (state.loadedTts && state.loadedTts !== state.tts));
  return {
    badge: `ON-DEVICE ${shortModelLabel(llm)}`,
    open: busy || unsupported || state.phase === 'error',
    modelChips: llmModels.map((model) => ({
      id: model.id,
      label: shortModelLabel(model),
      title: `${model.label} · ${formatBytes(model.bytes)}${model.recommended ? ' · recommended' : ''}${model.experimental ? ' · experimental' : ''}`,
      active: model.id === state.llm,
      disabled: busy,
      state: busy && model.id === state.llm ? 'loading' : 'idle',
    })),
    sttChips: sttModels.map((model) => ({
      id: model.id,
      label: model.label.toUpperCase(),
      title: `${model.label} · ${formatBytes(model.approxBytes)}`,
      active: model.id === state.stt,
      disabled: busy,
    })),
    ttsChips: ttsEngines
      .filter(
        (engine) => engine.id !== 'kokoro' || state.naturalVoice !== false,
      )
      .map((engine) => ({
        id: engine.id,
        label: engine.label.toUpperCase(),
        title: engine.note,
        active: engine.id === state.tts,
        disabled: busy,
      })),
    notice:
      state.tts === 'kokoro' &&
      state.naturalVoice !== false &&
      state.naturalNotice
        ? NATURAL_VOICE_NOTICE
        : null,
    clearLabel: state.clearing ? 'DELETING…' : 'DELETE DOWNLOADED MODELS',
    clearDisabled: Boolean(state.clearing) || busy || state.phase === 'ready',
    storageMessage: state.storageMessage || null,
    progressHidden: !progress,
    progressLabel: progress?.label || '',
    progressPercent: progress?.percent ?? 0,
    status,
    statusError: Boolean(unsupported || state.phase === 'error'),
    note: pending
      ? 'Model change applies when voice restarts'
      : state.speechNote
        ? state.speechNote
        : state.microphone === 'unavailable'
          ? 'Microphone unavailable · typed commands still work'
          : state.storageNote || null,
  };
}
