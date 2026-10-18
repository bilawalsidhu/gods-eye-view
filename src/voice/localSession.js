import { createBrowserLocalRuntime } from './browserLocalRuntime.js';
import {
  createLocalPcmRecorder,
  hasLocalSpeech,
  localSpeechSamples,
} from './localAudioCapture.js';
import { localJson, runLocalTurn } from './localConversation.js';
import { localSpeechChunks } from './localCommands.js';
import {
  isInteractiveSpaceTarget,
  isPushToTalkKey,
} from './realtimeInputPolicy.js';

/** Local recording -> Whisper -> Bonsai/actions -> Piper, without browser cloud speech APIs. */
export function createLocalSession({
  emit,
  runAction,
  signal,
  ui,
  config,
  radioLayer,
  runtime = createBrowserLocalRuntime(config),
}) {
  let active,
    operation,
    stream,
    recorder,
    context,
    source,
    meter,
    timer,
    audio,
    audioUrl;
  let history = [],
    processing = false,
    held = false,
    manual = false,
    bound = false;
  const state = (value, detail) =>
    emit({ type: 'state', state: value, detail });
  const detail = (text) => {
    if (ui.detail) ui.detail.textContent = text;
  };
  const current = (session) => active === session && !session.signal.aborted;
  const combined = (session) =>
    AbortSignal.any(
      [
        session.signal,
        operation?.signal,
        signal,
        AbortSignal.timeout(180000),
      ].filter(Boolean),
    );
  const stopAudio = () => {
    if (audio) {
      audio.pause();
      audio.src = '';
      audio = null;
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    ui.root.dataset.speaker = 'idle';
  };
  function stop({ removeUi = false, preserveStatus = false } = {}) {
    active?.abort();
    operation?.abort();
    operation = null;
    runtime.stop();
    active = null;
    clearInterval(timer);
    timer = null;
    recorder?.close();
    recorder = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    source?.disconnect();
    source = null;
    void context?.close().catch(() => {});
    context = null;
    stopAudio();
    history = [];
    processing = false;
    held = false;
    if (!preserveStatus) state('idle', 'Local voice off');
    if (removeUi) {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      signal?.removeEventListener('abort', abort);
    }
  }
  function fail(error, session) {
    if (!current(session)) return;
    stop({ preserveStatus: true });
    state('error', error.message);
  }
  async function speak(text, session) {
    const turnSignal = combined(session);
    for (const chunk of localSpeechChunks(text)) {
      turnSignal.throwIfAborted();
      const blob = await runtime.speech(chunk, turnSignal, (message) => {
        if (current(session) && !turnSignal.aborted) detail(message);
      });
      turnSignal.throwIfAborted();
      if (!current(session)) return;
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      ui.root.dataset.speaker = 'ai';
      await new Promise((resolve, reject) => {
        const done = () => {
          turnSignal.removeEventListener('abort', done);
          resolve();
        };
        turnSignal.addEventListener('abort', done, { once: true });
        audio.onended = done;
        audio.onerror = () => {
          turnSignal.removeEventListener('abort', done);
          reject(new Error('Could not play local speech'));
        };
        audio.play().catch((error) => {
          turnSignal.removeEventListener('abort', done);
          reject(error);
        });
      });
      turnSignal.throwIfAborted();
      if (current(session)) stopAudio();
    }
    if (current(session)) detail(text);
  }
  async function turn(text, session) {
    const turnSignal = combined(session);
    state('executing', 'LOCAL · THINKING');
    const result = await runLocalTurn({
      text,
      history,
      language: config.language,
      runAction,
      signal: turnSignal,
      emit,
      request: (path, body, turnSignal) =>
        path === 'chat'
          ? runtime.chat(body.messages, turnSignal, (message) => {
              if (current(session) && !turnSignal.aborted) detail(message);
            })
          : localJson(path, body, turnSignal),
    });
    turnSignal.throwIfAborted();
    if (!current(session)) return;
    history = result.history;
    detail(result.text);
    await speak(result.text, session);
    if (current(session)) emit({ type: 'completion', status: 'completed' });
  }
  function listen(session) {
    // Space can be pressed again while models or microphone permission are pending.
    if (!stream || !meter || !recorder || recorder.state !== 'inactive') return;
    if (!current(session) || processing || (manual && !held)) {
      if (current(session) && !processing)
        state('listening', 'LOCAL · HOLD SPACE TO SPEAK');
      return;
    }
    recorder.start(async (pcm, sampleRate) => {
      if (!current(session)) return;
      clearInterval(timer);
      timer = null;
      if (!hasLocalSpeech(pcm, sampleRate)) {
        listen(session);
        return;
      }
      processing = true;
      const task = new AbortController();
      operation = task;
      try {
        state('executing', 'LOCAL · TRANSCRIBING');
        const samples = await localSpeechSamples(pcm, sampleRate);
        if (!current(session) || task.signal.aborted) return;
        const { text } = await runtime.transcribe(samples, combined(session));
        if (current(session) && !task.signal.aborted && text?.trim())
          await turn(text, session);
      } catch (error) {
        if (!task.signal.aborted) fail(error, session);
      } finally {
        if (current(session) && operation === task) {
          operation = null;
          processing = false;
          listen(session);
        }
      }
    });
    state(
      'listening',
      `LOCAL ${config.profile.toUpperCase()} · ${manual ? 'RELEASE SPACE TO SEND' : 'SPEAK, THEN PAUSE'}`,
    );
    const samples = new Float32Array(meter.fftSize);
    const began = performance.now();
    let voiced = false,
      lastVoice = began;
    timer = setInterval(() => {
      if (!current(session) || recorder?.state !== 'recording') return;
      meter.getFloatTimeDomainData(samples);
      const level = Math.sqrt(
        samples.reduce((total, sample) => total + sample * sample, 0) /
          samples.length,
      );
      const now = performance.now();
      if (level > 0.018) {
        voiced = true;
        lastVoice = now;
      }
      ui.root.dataset.speaker = level > 0.018 ? 'user' : 'idle';
      if ((!manual && voiced && now - lastVoice > 1000) || now - began > 20000)
        recorder.stop();
    }, 100);
  }
  async function start({ pushToTalk = false } = {}) {
    if (active) return;
    const session = new AbortController();
    active = session;
    processing = true;
    manual = pushToTalk;
    state('connecting', 'Checking local models…');
    try {
      await runtime.prepare(combined(session), (message) => {
        if (current(session)) state('connecting', message);
      });
      if (!current(session)) return;
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          'Local voice requires microphone access on localhost or HTTPS',
        );
      radioLayer?.pause?.();
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!current(session)) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = microphone;
      context = new AudioContext();
      await context.resume();
      if (!current(session)) return;
      source = context.createMediaStreamSource(stream);
      meter = context.createAnalyser();
      meter.fftSize = 1024;
      source.connect(meter);
      const capture = await createLocalPcmRecorder(context, source, (error) =>
        fail(error, session),
      );
      if (!current(session)) {
        capture.close();
        return;
      }
      recorder = capture;
      processing = false;
      listen(session);
    } catch (error) {
      fail(error, session);
    }
  }
  function keyDown(event) {
    if (
      !isPushToTalkKey(event) ||
      event.repeat ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      isInteractiveSpaceTarget(event.target)
    )
      return;
    event.preventDefault();
    held = true;
    if (processing && operation) {
      operation.abort();
      operation = null;
      stopAudio();
      processing = false;
    }
    if (!active) void start({ pushToTalk: true });
    else if (!processing && recorder?.state === 'inactive') {
      manual = true;
      listen(active);
    }
  }
  function keyUp(event) {
    if (!isPushToTalkKey(event) || !held) return;
    event.preventDefault();
    held = false;
    if (manual && recorder?.state === 'recording') recorder.stop();
  }
  const blur = () => {
    if (held) keyUp({ code: 'Space', preventDefault() {} });
  };
  const abort = () => stop({ removeUi: true });
  signal?.addEventListener('abort', abort, { once: true });
  return {
    capabilities: { costControls: false, pushToTalk: true },
    start,
    stop,
    async sendText(text) {
      if (
        !active ||
        (processing && !operation) ||
        typeof text !== 'string' ||
        !text.trim()
      )
        return false;
      const session = active;
      operation?.abort();
      stopAudio();
      const task = new AbortController();
      operation = task;
      if (recorder?.state !== 'inactive') {
        recorder?.cancel();
        clearInterval(timer);
      }
      processing = true;
      try {
        await turn(text, session);
        return true;
      } catch (error) {
        if (!task.signal.aborted) fail(error, session);
        return false;
      } finally {
        if (current(session) && operation === task) {
          operation = null;
          processing = false;
          listen(session);
        }
      }
    },
    sendMapEvent() {},
    ignoreButtonClick: () => held,
    bindControls() {
      if (bound) return;
      bound = true;
      if (ui.helpDetail)
        ui.helpDetail.textContent =
          'Local · click to talk hands-free, or hold Space to speak';
      detail(`LOCAL ${config.profile.toUpperCase()} · ${config.model}`);
      window.addEventListener('keydown', keyDown);
      window.addEventListener('keyup', keyUp);
      window.addEventListener('blur', blur);
    },
  };
}
