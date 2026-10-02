import { RealtimeInput } from '../realtimeInput.js';
import {
  createMarkupFilter,
  parseGemmaToolCalls,
  stripGemmaMarkup,
} from './gemmaToolCalls.js';
import { createMicrophoneCapture } from './localAudio.js';
import {
  checkModelStorage,
  clearDownloadedModels,
  localVoiceEngine,
  probeLocalVoiceSupport,
} from './localEngine.js';
import { LOCAL_SYSTEM_PROMPT } from './localPrompt.js';
import { createLocalRadioHandoff, pendingRadioPlayback } from './localRadio.js';
import { LocalVoiceControls } from './localVoiceControls.js';
import {
  markNaturalVoiceNoticeSeen,
  naturalVoiceNoticeSeen,
  readLocalVoiceSettings,
  writeLocalVoiceModel,
  writeLocalVoiceStt,
  writeLocalVoiceTts,
} from './localVoicePreferences.js';
import { createLocalVoiceStore } from './localVoiceStore.js';
import { findLlmModel, findSttModel } from './modelCatalog.js';
import {
  actionReply,
  combineReplies,
  compactResultForModel,
  fallbackAnswer,
  isMaterialReply,
  needsContinuation,
  needsSpokenAnswer,
  progressReply,
} from './replies.js';
import {
  createKokoroOutput,
  createSilentOutput,
  createSystemOutput,
  loadSystemVoices,
  pickOnDeviceVoice,
} from './speechOutput.js';
import { createSentenceSplitter, normalizeForSpeech } from './speechText.js';
import {
  ACTION_SCHEMA_BY_NAME,
  buildLocalTools,
  coerceArguments,
} from './toolset.js';

const MIN_UTTERANCE_SAMPLES = 16000 * 0.25;
const READY_HINT = 'Hold Space to talk';
const SLOW_ACTION_MS = 700;
const MAX_TOOL_ROUNDS = 2;

function rootMeanSquare(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Voice session adapter for the zero-install tier: push-to-talk capture,
 * speech recognition, a Gemma 4 tool-calling model and a swappable speech
 * output, all on this device. Actions run through the shared session runner.
 */
export function createLocalWebSession({
  emit,
  runAction,
  ui,
  radioLayer = null,
  viewer = null,
  storage,
  runtime = {},
}) {
  // The on-device runtime; tests substitute an engine, probes and outputs.
  const {
    createEngine = localVoiceEngine,
    probeSupport = probeLocalVoiceSupport,
    checkStorage = checkModelStorage,
    openMicrophone = createMicrophoneCapture,
    createOutput = null,
  } = runtime;
  const settings = readLocalVoiceSettings({ storage });
  const store = createLocalVoiceStore({
    llm: settings.llm,
    stt: settings.stt,
    tts: settings.tts,
    naturalVoice: settings.naturalVoice,
    // The one-line download notice shows until natural voice first starts.
    naturalNotice: !naturalVoiceNoticeSeen(storage),
  });
  const metrics = [];
  let engine = null;
  let status = 'idle';
  let active = false;
  let startGeneration = 0;
  let turnGeneration = 0;
  let current = null;
  let mic = null;
  let speechChain = Promise.resolve();
  let lastUtterance = null;

  const radio = createLocalRadioHandoff({ radioLayer });
  let speech = createSilentOutput();
  const speakerHooks = {
    onSpeaking: () => ui && input.setVoiceSpeaker('ai'),
    onIdle: () => {
      if (ui && !mic?.recording) input.setVoiceSpeaker('idle');
    },
  };

  const input = new RealtimeInput({
    readUi: () => ui,
    readStream: () => mic?.stream || null,
    readStatus: () => status,
    operations: {
      isActive: () => active,
      setStatus,
      start: (options) => startFromGesture(options),
      pauseRadioForVoice: () => radio.silenceForVoice(),
      setMicrophoneEnabled: (enabled) => {
        if (enabled) beginRecording();
        else void endRecording();
      },
    },
  });

  let controls = null;
  const actions = {
    selectModel(id) {
      const chosen = writeLocalVoiceModel(id, storage);
      if (chosen) store.update({ llm: chosen });
    },
    selectStt(id) {
      const chosen = writeLocalVoiceStt(id, storage);
      if (chosen) store.update({ stt: chosen });
    },
    selectTts(id) {
      const chosen = writeLocalVoiceTts(id, storage);
      if (chosen) store.update({ tts: chosen });
    },
    async clearModels() {
      if (active || store.getState().clearing) return;
      store.update({ clearing: true, storageMessage: null });
      engine?.terminate();
      engine = null;
      const removed = await clearDownloadedModels().catch(() => 0);
      store.update({
        clearing: false,
        loadedLlm: null,
        loadedStt: null,
        loadedTts: null,
        storageNote: null,
        storageMessage: removed
          ? 'Downloaded models deleted.'
          : 'No downloaded models found.',
      });
    },
  };

  async function createSpeech(ttsEngine) {
    if (createOutput) return createOutput(ttsEngine, speakerHooks);
    if (ttsEngine === 'kokoro' && engine?.kokoroReady && engine.kokoro)
      return createKokoroOutput({ client: engine.kokoro, ...speakerHooks });
    // Natural voice that could not load falls back to a system voice.
    if (ttsEngine === 'system' || ttsEngine === 'kokoro') {
      const voice = pickOnDeviceVoice(await loadSystemVoices());
      if (voice) return createSystemOutput({ voice, ...speakerHooks });
      store.update({
        storageMessage: 'No on-device system voice; replies are text only.',
      });
    }
    return createSilentOutput();
  }

  function setStatus(state, detail) {
    status = state;
    emit({ type: 'state', state, detail });
  }

  function isCurrentTurn(id) {
    return active && id === turnGeneration;
  }

  async function ensureModels(attempt) {
    const { llm, stt, tts } = store.getState();
    const llmModel = findLlmModel(llm);
    const sttModel = findSttModel(stt);
    const current = () => attempt === startGeneration && active;
    engine = createEngine();
    store.update({ phase: 'loading', progress: {} });
    const loaded = await engine.ensure({
      llmModel,
      sttModel,
      ttsEngine: tts,
      system: LOCAL_SYSTEM_PROMPT,
      tools: buildLocalTools(),
      onProgress: (key, event) => {
        if (!current()) return;
        store.progress(key, event);
        if (event.total)
          setStatus(
            'connecting',
            `Loading ${Math.round((event.loaded / event.total) * 100)}%`,
          );
      },
      onPhase: (phase) => {
        if (!current()) return;
        store.update({ phase, progress: {} });
        setStatus('connecting', 'Preparing model');
      },
    });
    if (!current()) return engine;
    const timings = loaded.loads.at(-1)?.timings || {};
    const cache = timings.llm?.cache;
    if (tts === 'kokoro' && timings.ttsError)
      store.update({
        speechNote: `Natural voice unavailable (${timings.ttsError}); using a system voice.`,
      });
    else if (tts === 'kokoro' && loaded.kokoroReady) {
      markNaturalVoiceNoticeSeen(storage);
      store.update({ speechNote: null });
    }
    store.update({
      loadedLlm: llmModel.id,
      loadedStt: sttModel.id,
      loadedTts: tts,
      progress: {},
      ...(cache && !cache.ok
        ? {
            storageMessage: `${llmModel.label} was not kept for next time: ${cache.error}`,
          }
        : {}),
    });
    return engine;
  }

  async function start({ pushToTalk = false } = {}) {
    if (active) return;
    const attempt = ++startGeneration;
    active = true;
    input.pushToTalkMode = true;
    setStatus('connecting', 'Checking this device');
    store.update({ phase: 'checking', message: null, support: null });
    const support = await probeSupport(findLlmModel(store.getState().llm));
    if (attempt !== startGeneration) return;
    store.update({ support });
    if (!support.ok) {
      active = false;
      store.update({ phase: 'error', message: support.reason });
      throw new Error(support.reason);
    }
    setStatus('connecting', 'Loading local models');
    try {
      const { llm, stt, tts } = store.getState();
      const storageCheck = await checkStorage({
        llm: findLlmModel(llm),
        stt: findSttModel(stt),
        ttsEngine: tts,
      });
      if (attempt !== startGeneration) return;
      store.update({ storageNote: storageCheck.note, storageMessage: null });
      await ensureModels(attempt);
      const output = await createSpeech(store.getState().tts);
      if (attempt !== startGeneration || !active) {
        output.close();
        return;
      }
      speech.close();
      speech = output;
    } catch (error) {
      if (attempt !== startGeneration) return;
      store.update({
        phase: 'error',
        message: error?.message || String(error),
        progress: {},
      });
      throw error;
    }
    if (attempt !== startGeneration || !active) return;
    try {
      mic = await openMicrophone();
      input.startVoiceVisualizer(mic.stream);
      if (speech.stream) input.startAssistantVoiceVisualizer(speech.stream);
      store.update({ microphone: 'ready' });
    } catch {
      mic = null;
      store.update({ microphone: 'unavailable' });
    }
    if (attempt !== startGeneration || !active) {
      mic?.close();
      mic = null;
      return;
    }
    store.update({ phase: 'ready' });
    setStatus('listening', READY_HINT);
    if (ui) input.updateVoiceButtonLabel();
    if (pushToTalk && input.pushToTalkKeyHeld) beginRecording();
  }

  async function startFromGesture(options) {
    const attempt = startGeneration + 1;
    try {
      await start(options);
    } catch (error) {
      if (attempt !== startGeneration) return;
      stop({ preserveStatus: true });
      setStatus('error', error?.message || String(error));
    }
  }

  function interrupt() {
    const running = current;
    current = null;
    turnGeneration++;
    if (running?.llmTurnId) engine?.llm.cancel(running.llmTurnId);
    radio.cancel();
    speech.stop();
    speechChain = Promise.resolve();
    if (running) emit({ type: 'interruption' });
  }

  function beginRecording() {
    if (!active || !mic || status === 'connecting') return;
    interrupt();
    mic.start();
    if (ui?.root) ui.root.dataset.microphone = 'active';
    if (ui) input.setVoiceSpeaker('user');
    setStatus('listening', 'Release Space to send');
  }

  async function endRecording() {
    if (!mic?.recording) return;
    const endOfInput = performance.now();
    const audio = await mic.stop();
    if (ui?.root) ui.root.dataset.microphone = 'muted';
    if (ui) input.setVoiceSpeaker('idle');
    lastUtterance = { samples: audio.length, rms: rootMeanSquare(audio) };
    if (!active) return;
    if (audio.length < MIN_UTTERANCE_SAMPLES) {
      setStatus('listening', READY_HINT);
      return;
    }
    await transcribeAndRun(audio, endOfInput);
  }

  async function transcribeAndRun(audio, endOfInput = performance.now()) {
    if (!active || !engine?.prepared) return null;
    interrupt();
    const turn = turnGeneration;
    setStatus('executing', 'Transcribing');
    let transcript;
    try {
      transcript = await engine.stt.transcribe(audio);
    } catch (error) {
      if (isCurrentTurn(turn)) setStatus('listening', 'Could not transcribe');
      return null;
    }
    if (!isCurrentTurn(turn)) return null;
    if (!transcript.text) {
      setStatus('listening', 'Nothing heard, try again');
      return null;
    }
    return runTurn(transcript.text, {
      endOfInput,
      stt: { ms: transcript.ms, audioMs: transcript.audioMs },
      source: 'voice',
    });
  }

  function speak(text, record, turn) {
    const clean = normalizeForSpeech(text);
    if (!clean) return;
    const splitter = createSentenceSplitter({ minChars: 8 });
    for (const sentence of [...splitter.push(clean), ...splitter.flush()])
      queueSentence(sentence, record, turn);
  }

  function queueSentence(sentence, record, turn) {
    speechChain = speechChain.then(async () => {
      if (!isCurrentTurn(turn)) return;
      const spoken = await speech.speak(sentence).catch(() => null);
      if (!spoken || !isCurrentTurn(turn)) return;
      record.tts.push(Math.round(spoken.ms));
      if (record.firstAudioMs == null && spoken.delayMs != null)
        record.firstAudioMs = Math.round(
          performance.now() + spoken.delayMs - record.endOfInput,
        );
    });
    return speechChain;
  }

  function countFrames() {
    const scene = viewer?.scene;
    if (!scene?.postRender) return () => null;
    let frames = 0;
    const started = performance.now();
    const remove = scene.postRender.addEventListener(() => {
      frames++;
    });
    return () => {
      remove();
      const ms = performance.now() - started;
      return ms > 0 ? Math.round((frames * 10000) / ms) / 10 : null;
    };
  }

  async function decode(promise, record) {
    const stopCounting = countFrames();
    try {
      return await promise;
    } finally {
      const fps = stopCounting();
      if (record && fps != null) record.decodeFps.push(fps);
    }
  }

  async function runTurn(
    text,
    { endOfInput = performance.now(), stt = null, source = 'text' } = {},
  ) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !active || !engine?.prepared) return null;
    interrupt();
    const turn = turnGeneration;
    const record = {
      id: metrics.length + 1,
      text: trimmed,
      source,
      model: store.getState().loadedLlm,
      stt,
      endOfInput,
      actions: [],
      tts: [],
      firstToolCallMs: null,
      firstActionMs: null,
      firstAudioMs: null,
      decodeFps: [],
      answers: [],
    };
    metrics.push(record);
    current = { turn, record, llmTurnId: null };
    emit({ type: 'transcript', role: 'user', text: trimmed, final: true });
    store.update({ lastUser: trimmed, lastReply: null });
    setStatus('executing', 'Thinking');

    const executed = [];
    let chain = Promise.resolve();
    const execute = async (call) => {
      if (!isCurrentTurn(turn)) return;
      const name = call.name;
      let args = call.arguments;
      if (!ACTION_SCHEMA_BY_NAME.has(name)) {
        executed.push({ name, reply: 'I can’t do that.' });
        return;
      }
      args = coerceArguments(name, args);
      const entry = {
        name,
        args,
        atMs: Math.round(performance.now() - endOfInput),
      };
      record.actions.push(entry);
      if (record.firstActionMs == null) record.firstActionMs = entry.atMs;
      setStatus('executing', 'Running command');
      const pending = runAction(name, args);
      // Slow actions (a layer loading its feed) get an immediate spoken
      // acknowledgement; the result then only adds words if it failed.
      const slow = await Promise.race([
        pending.then(
          () => false,
          () => false,
        ),
        new Promise((resolve) => setTimeout(resolve, SLOW_ACTION_MS, true)),
      ]);
      const progress = slow ? progressReply(name, args) : null;
      if (progress && isCurrentTurn(turn)) speak(progress, record, turn);
      let result;
      try {
        result = await pending;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        result = { ok: false, error: error?.message || String(error) };
      }
      entry.ok = result?.ok !== false;
      entry.ms = Math.round(performance.now() - endOfInput) - entry.atMs;
      let reply = needsSpokenAnswer(name, result)
        ? null
        : actionReply(name, args, result);
      // The acknowledgement already said what is happening; the result adds
      // words only when it corrects or qualifies that ("…but its feed is
      // unavailable", "at least 500").
      if (progress && entry.ok && !isMaterialReply(name, args, result))
        reply = null;
      executed.push({ name, args, result, reply, progress });
    };
    // Each model message lists its calls cumulatively; dispatch new ones in
    // order as soon as they stream in.
    const dispatcher = () => {
      let dispatched = 0;
      return (calls) => {
        if (record.firstToolCallMs == null)
          record.firstToolCallMs = Math.round(performance.now() - endOfInput);
        for (const call of calls.slice(dispatched)) {
          dispatched++;
          chain = chain.then(() => execute(call));
        }
      };
    };
    const onToolCalls = dispatcher();

    // Query results go back to the model for one spoken answer. The model
    // may instead call more actions (look up, then track); those run and
    // their results feed the next round.
    const answerResults = async () => {
      setStatus('executing', 'Answering');
      const started = performance.now();
      let pending = executed.slice();
      let answer = '';
      for (let round = 0; round < MAX_TOOL_ROUNDS && pending.length; round++) {
        const results = pending
          .filter((entry) => entry.result)
          .map((entry) => ({
            name: entry.name,
            response: compactResultForModel(entry.result),
          }));
        if (!results.length) break;
        const before = executed.length;
        const splitter = createSentenceSplitter({ minChars: 8 });
        const markup = createMarkupFilter();
        const say = (sentences) => {
          for (const sentence of sentences) {
            const spoken = normalizeForSpeech(sentence);
            if (spoken) queueSentence(spoken, record, turn);
          }
        };
        let text = '';
        let answered;
        try {
          answered = await decode(
            engine.llm.continueTurn(handle.turnId, results, {
              onToolCalls: dispatcher(),
              onDelta: (delta) => {
                text += delta;
                say(splitter.push(markup.push(delta)));
              },
            }),
            record,
          );
        } catch {
          break;
        }
        if (answered.cancelled || !isCurrentTurn(turn)) return answer;
        say([...splitter.push(markup.flush()), ...splitter.flush()]);
        record.answers.push({
          round,
          ms: Math.round(performance.now() - started),
          stats: answered.stats,
        });
        answer = combineReplies([answer, stripGemmaMarkup(text)]);
        await chain;
        if (!isCurrentTurn(turn)) return answer;
        pending = executed.slice(before);
        const confirmations = combineReplies(
          pending.map((entry) => entry.reply),
        );
        if (confirmations) {
          speak(confirmations, record, turn);
          answer = combineReplies([answer, confirmations]);
        }
        if (
          !pending.some((entry) => needsContinuation(entry.name, entry.result))
        )
          break;
      }
      if (answer.trim()) return answer;
      // No words from the model: state the most recent lookup only.
      const last = executed
        .filter(
          (entry) =>
            needsSpokenAnswer(entry.name, entry.result) && entry.result,
        )
        .at(-1);
      const fallback = last ? fallbackAnswer(last.name, last.result) : '';
      speak(fallback, record, turn);
      return fallback;
    };

    const handle = engine.llm.turn(trimmed, { onToolCalls });
    current.llmTurnId = handle.turnId;
    let done;
    try {
      done = await decode(handle.done, record);
    } catch (error) {
      engine.llm.release(handle.turnId);
      if (!isCurrentTurn(turn)) return record;
      record.error = error?.message || String(error);
      setStatus('listening', 'Model error');
      store.update({ lastReply: 'Model error: ' + record.error });
      emit({
        type: 'transcript',
        role: 'assistant',
        text: 'Model error: ' + record.error,
        final: true,
      });
      return record;
    }
    record.llm = done.stats;
    if (done.cancelled || !isCurrentTurn(turn)) {
      engine.llm.release(handle.turnId);
      return record;
    }
    let modelText = done.text || '';
    if (!done.calls?.length && /<\|tool_call>/.test(modelText)) {
      const parsed = parseGemmaToolCalls(modelText);
      modelText = parsed.text;
      if (parsed.calls.length) onToolCalls(parsed.calls);
    }
    await chain;
    if (!isCurrentTurn(turn)) {
      engine.llm.release(handle.turnId);
      return record;
    }
    const confirmations = combineReplies(
      executed.filter((entry) => entry.reply).map((entry) => entry.reply),
    );
    const acknowledged = combineReplies(
      executed.map((entry) => entry.progress),
    );
    if (confirmations) speak(confirmations, record, turn);
    let reply = combineReplies([acknowledged, confirmations]);
    // Results the model must see continue the turn: answers to put into
    // words, or a lookup the next call depends on.
    if (
      executed.some(
        (entry) => entry.result && needsContinuation(entry.name, entry.result),
      )
    )
      reply = combineReplies([reply, await answerResults()]);
    else if (!executed.length) {
      reply = stripGemmaMarkup(modelText) || 'Sorry, I missed that.';
      speak(reply, record, turn);
    }
    if (!isCurrentTurn(turn)) {
      engine.llm.release(handle.turnId);
      return record;
    }
    record.calls = executed.map(({ name, args, result }) => ({
      name,
      args,
      ok: result ? result.ok !== false : false,
    }));
    record.reply = reply;
    store.update({ lastReply: reply });
    emit({ type: 'transcript', role: 'assistant', text: reply, final: true });
    engine.llm.release(handle.turnId);
    await speechChain;
    const radioPlayback = pendingRadioPlayback(executed);
    if (radioPlayback && isCurrentTurn(turn)) {
      // Radio starts only after the confirmation has been heard.
      await speech.idle();
      if (isCurrentTurn(turn))
        await handOffToRadio(radioPlayback, turn, record);
    }
    if (!isCurrentTurn(turn)) return record;
    current = null;
    emit({ type: 'completion', status: 'completed' });
    setStatus('listening', READY_HINT);
    return record;
  }

  async function handOffToRadio(result, turn, record) {
    setStatus('executing', 'Starting Radio');
    const outcome = await radio.start(result, {
      isCurrent: () => isCurrentTurn(turn),
      stopVoice: () => {
        current = null;
        stop({ preserveRadioPlayback: true });
        emit({ type: 'state', state: 'idle', detail: 'Radio playing' });
      },
    });
    record.radio = outcome.result?.audioState || null;
    if (outcome.result?.ok || outcome.cancelled || !isCurrentTurn(turn)) return;
    const correction = 'The Radio station could not start. Voice is still on.';
    store.update({ lastReply: correction });
    emit({
      type: 'transcript',
      role: 'assistant',
      text: correction,
      final: true,
    });
    speak(correction, record, turn);
    await speechChain;
    if (isCurrentTurn(turn)) setStatus('listening', 'Radio did not start');
  }

  function stop({ removeUi = false, preserveRadioPlayback = false } = {}) {
    startGeneration++;
    if (preserveRadioPlayback) {
      turnGeneration++;
      current = null;
      speech.stop();
      speechChain = Promise.resolve();
    } else if (active || current) interrupt();
    else radio.cancel();
    radio.release();
    active = false;
    current = null;
    mic?.close();
    mic = null;
    input.stopVoiceVisualizer();
    input.resetSession();
    if (ui) input.updateVoiceButtonLabel();
    if (store.getState().phase !== 'error')
      store.update({ phase: 'idle', progress: {} });
    if (removeUi) {
      input.detachBindings();
      controls?.destroy();
      controls = null;
      speech.close();
      engine?.terminate();
      engine = null;
    }
  }

  const local = {
    settings,
    store,
    metrics,
    get status() {
      return status;
    },
    get engine() {
      return engine;
    },
    /** Runs one typed turn through the local pipeline and resolves with its metrics. */
    runText: (text) => runTurn(text, { source: 'text' }),
    /** Transcribes 16 kHz samples and runs the resulting turn. */
    runAudio: (samples) => transcribeAndRun(samples),
    speechIdle: () => speechChain,
    get lastUtterance() {
      return lastUtterance;
    },
  };

  return {
    capabilities: { costControls: false, pushToTalk: true, local: true },
    local,
    start,
    stop,
    sendText(text) {
      void runTurn(text, { source: 'text' });
      return true;
    },
    sendMapEvent() {
      return false;
    },
    ignoreButtonClick: () => Boolean(input.spaceKeyHeld),
    bindControls() {
      input.bindPushToTalkShortcut();
      if (ui) input.updateVoiceButtonLabel();
      if (ui?.root && !controls)
        controls = new LocalVoiceControls({
          root: ui.root,
          store,
          actions,
          engineControls: ui.engineControls || null,
        });
    },
  };
}
