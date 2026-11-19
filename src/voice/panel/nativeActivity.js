/** Inspected native capabilities only; scheduled/reported output is not acoustics. */
export function observeNativeActivity({
  adapter,
  nativeProvider,
  signal,
  onChange,
  onInput,
}) {
  const native = nativeProvider === 'openai' || nativeProvider === 'gemini';
  // Do not even inspect custom controller properties.
  const controller = native ? adapter.controller : null;
  const input = native
    ? nativeProvider === 'gemini'
      ? controller.input
      : controller._input
    : null;
  let dead = false,
    connected = false,
    inputBusy = false,
    recoverableError = false;
  function cleanNativeOutput() {
    if (nativeProvider === 'gemini') return true;
    if (nativeProvider !== 'openai') return false;
    const turns = controller._turns;
    return (
      ['idle', 'connecting', 'error'].includes(controller.status) &&
      controller.dc == null &&
      !turns.assistantAudioPlaying &&
      !turns.responseActive &&
      !turns.responseCreatePending &&
      !turns.userTurnPending &&
      !turns.activeResponseId &&
      !turns.progressResponse
    );
  }
  let outputKnown = cleanNativeOutput();
  let audio = null,
    version = 0;
  const restores = [];
  const audioRestores = [];
  const pendingOutput = new Map();
  let untrackedOutput = !outputKnown;
  function retireAudio() {
    audio = null;
    for (const restore of audioRestores.splice(0).reverse()) restore();
  }
  function refreshOutputKnowledge() {
    outputKnown = !untrackedOutput && pendingOutput.size === 0;
  }
  function hasNoAudioOutput(response) {
    return (
      ['completed', 'cancelled', 'failed', 'incomplete'].includes(
        response?.status,
      ) &&
      Array.isArray(response.output) &&
      response.output.every(
        (item) =>
          item?.type === 'function_call' ||
          (item?.type === 'message' &&
            Array.isArray(item.content) &&
            item.content.every((part) =>
              ['text', 'output_text', 'refusal'].includes(part?.type),
            )),
      )
    );
  }
  function snapshot() {
    const turns = nativeProvider === 'openai' ? controller?._turns : controller;
    return {
      known: native && outputKnown && !dead,
      connected: connected && !dead,
      held: Boolean(input?.pushToTalkKeyHeld),
      inputBusy: Boolean(
        inputBusy ||
        (nativeProvider === 'gemini' && controller?.userActivityOpen),
      ),
      outputBusy: Boolean(
        nativeProvider === 'gemini'
          ? audio && audio === controller.audio && audio.pending
          : turns?.assistantAudioPlaying,
      ),
      generationBusy: Boolean(
        turns?.responseActive ||
        turns?.responseCreatePending ||
        (nativeProvider === 'openai' && turns?.userTurnPending) ||
        (nativeProvider === 'gemini' &&
          (turns?.replyPending ||
            turns?.retiredReplyPending ||
            turns?.deferredInput ||
            turns?.automaticTurnOpen ||
            turns?.pendingTools ||
            turns?.controlQueue?.length)),
      ),
    };
  }
  function notify() {
    if (!dead) {
      try {
        onChange?.(snapshot());
      } catch {}
    }
  }
  function wrap(object, key, after, ownedRestores = restores) {
    const original = object?.[key];
    if (typeof original !== 'function') return;
    function wrapped(...args) {
      const stamp = version;
      const result = Reflect.apply(original, this, args);
      if (!dead && stamp === version) {
        try {
          after?.(args, result);
        } catch {}
      }
      return result;
    }
    object[key] = wrapped;
    ownedRestores.push(() => {
      if (object[key] === wrapped) object[key] = original;
    });
  }
  function handle(event) {
    if (dead || !native) return;
    if (event?.type === 'state') {
      const state = event.state;
      const wasConnected = connected;
      const liveError =
        state === 'error' &&
        nativeProvider === 'openai' &&
        controller.dc?.readyState === 'open';
      const restartingAfterError = state === 'connecting' && recoverableError;
      recoverableError = liveError;
      connected = !['idle', 'connecting', 'error'].includes(state);
      // Connecting has multiple native phases around audio allocation. Retire
      // a previous connected generation once, not each phase of this start.
      // A failed reply can briefly report error on a live OpenAI transport.
      // Preserve its output evidence through recovery to listening; a later
      // reconnect still retires the failed connection's generation.
      if (
        state === 'idle' ||
        (state === 'error' && !liveError) ||
        (state === 'connecting' && (wasConnected || restartingAfterError))
      ) {
        version++;
        retireAudio();
        inputBusy = false;
        outputKnown = cleanNativeOutput();
        untrackedOutput = !outputKnown;
        pendingOutput.clear();
      }
    }
    notify();
  }
  if (native) {
    wrap(controller, 'sendTextCommand', ([text], result) => {
      if (String(text || '').trim() && result !== false) onInput?.();
    });
    for (const key of [
      'setMicrophoneEnabled',
      'releasePushToTalkKey',
      'resetSession',
    ])
      wrap(input, key, notify);
    if (nativeProvider === 'openai') {
      wrap(controller._turns, 'observeSpeech', ([event]) => {
        if (event?.type === 'input_audio_buffer.speech_started')
          inputBusy = true;
        if (event?.type === 'input_audio_buffer.speech_stopped')
          inputBusy = false;
        const type = event?.type;
        const id = event?.response_id || event?.response?.id;
        // Keep each unresolved response separate: a later silent reply cannot
        // establish that an earlier audio reply has drained.
        if (type === 'response.created') {
          if (id && pendingOutput.size < 64)
            pendingOutput.set(id, { audioSeen: false });
          else untrackedOutput = true;
        }
        const pending = pendingOutput.get(id);
        if (
          pending &&
          (type?.startsWith('response.output_audio') ||
            type?.startsWith('response.audio') ||
            ['audio', 'output_audio'].includes(event?.part?.type))
        )
          pending.audioSeen = true;
        if (
          type === 'response.done' &&
          pending &&
          !pending.audioSeen &&
          hasNoAudioOutput(event.response)
        )
          pendingOutput.delete(id);
        if (
          type === 'output_audio_buffer.started' ||
          type === 'output_audio_buffer.cleared'
        ) {
          // Native playback events establish the transport's output lifecycle.
          // Generation completion alone never establishes audio drainage.
          untrackedOutput = false;
          if (id) pendingOutput.delete(id);
          else pendingOutput.clear();
        }
        refreshOutputKnowledge();
        notify();
      });
    } else {
      wrap(controller, 'handleMessage', notify);
      const original = controller.createAudio;
      function createAudio(...args) {
        const stamp = version;
        const options = args[0];
        let current;
        const decorated = { ...options };
        for (const key of [
          'onAudioStart',
          'onAudioEnd',
          'onAudioDiscard',
          'onDrain',
        ]) {
          const callback = options?.[key];
          decorated[key] = function (...values) {
            const result =
              typeof callback === 'function'
                ? Reflect.apply(
                    callback,
                    this === decorated ? options : this,
                    values,
                  )
                : undefined;
            if (
              !dead &&
              stamp === version &&
              audio === current &&
              controller.audio === current
            ) {
              if (
                key === 'onAudioStart' &&
                options.pushToTalk &&
                controller.captureOwner?.admitted
              )
                inputBusy = true;
              if (key === 'onAudioEnd' || key === 'onAudioDiscard')
                inputBusy = false;
              notify();
            }
            return result;
          };
        }
        const forwarded = args.slice();
        forwarded[0] = decorated;
        current = Reflect.apply(original, this, forwarded);
        if (!dead && stamp === version) {
          retireAudio();
          audio = current;
          inputBusy = false;
          for (const key of ['play', 'clearPlayback', 'close'])
            wrap(
              current,
              key,
              () => {
                if (audio !== current) return;
                if (key === 'close') {
                  retireAudio();
                  inputBusy = false;
                }
                if (controller.audio === current) notify();
              },
              audioRestores,
            );
        }
        return current;
      }
      controller.createAudio = createAudio;
      restores.push(() => {
        if (controller.createAudio === createAudio)
          controller.createAudio = original;
      });
    }
  }
  function destroy() {
    if (dead) return;
    dead = true;
    version++;
    retireAudio();
    pendingOutput.clear();
    for (const restore of restores.splice(0).reverse()) restore();
    signal?.removeEventListener('abort', destroy);
  }
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy();
  return { snapshot, handle, destroy };
}
