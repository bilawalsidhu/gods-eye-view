import { realtimeSessionEvent } from './realtimeEvents.js';
import { readLayerLifecycleSummary } from './layerSummary.js';
import {
  CALL_DEDUPE_MS,
  SUPERSEDED_RESPONSE_MEMORY,
  shouldStopVoiceAfterRadioTool,
  responseInstructionForToolResult,
  extractFunctionCalls,
  callDedupeKeys,
  parseArguments,
} from './realtimeProtocol.js';
import { narrationLabel } from './speech.js';

/** Out-of-band progress responses carry this metadata tag. */
export const PROGRESS_RESPONSE_TAG = 'progress';

/**
 * Speaks one code-authored progress line out of band. The line travels as
 * input data, never inside the instruction text.
 */
const PROGRESS_INSTRUCTIONS =
  'Read the user message aloud exactly, as a brief status update in your normal voice. Say nothing else.';

/** Tools never narrated: Radio owns the speaker for its own handoff. */
const SILENT_TOOLS = new Set(['control_radio']);

/** Remembered response ids for preamble and progress detection. */
const SPEECH_RESPONSE_MEMORY = 8;

/** A progress line is one short sentence; this bounds its cost. */
export const PROGRESS_MAX_OUTPUT_TOKENS = 60;

/** Own response sequencing, tool execution, deduplication and superseded intent. */
export class RealtimeTurns {
  constructor({
    readActionExecutor,
    readRunner,
    readChannel,
    readDataManager,
    readRadioLayer,
    radio,
    viewport,
    metrics = null,
    operations,
  }) {
    Object.assign(
      this,
      {
        readActionExecutor,
        readRunner,
        readChannel,
        readDataManager,
        readRadioLayer,
        radio,
        viewport,
        metrics,
      },
      operations,
    );
    this.processedCalls = new Map();
    this.responseActive = false;
    this.responseCreatePending = false;
    this.userTurnPending = false;
    this.pendingResponseInstructions = null;
    this.pendingUserTextResponse = false;
    this.activeResponseId = null;
    this.supersededResponseIds = new Set();
    this.activeToolAbortControllers = new Set();
    this.narration = null;
    this.narrationSequence = 0;
    this.assistantAudioPlaying = false;
    this.speechResponseIds = new Set();
    this.progressResponse = null;
    this.progressResponseIds = new Set();
    this.bestEffortEventIds = new Set();
    this.bestEffortSequence = 0;
  }
  get actionExecutor() {
    return this.readActionExecutor();
  }
  get runner() {
    return this.readRunner();
  }
  get dc() {
    return this.readChannel();
  }
  get dataManager() {
    return this.readDataManager();
  }
  get radioLayer() {
    return this.readRadioLayer();
  }
  /**
   * Inject a background MAP EVENT into the conversation as a system item — e.g. a
   * deferred annotation outline that resolved or failed after its tool result
   * already returned. Deliberately NO response.create: the model reads it on its
   * next turn and can confirm or correct without talking over the user. The
   * payload is serialized JSON, so place names stay structured DATA (the same
   * injection hygiene as failedLabels), never instruction-bearing prose.
   */
  notifyMapEvent(payload) {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    return this.sendRealtimeEvent(
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: JSON.stringify(payload) }],
        },
      },
      'client.map_event',
    );
  }

  sendTextCommand(text) {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('GEV voice is not connected');
    }
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    this.cancelRadioHandoff({ abortTools: true });
    this.supersedeActiveResponseForUserTurn();
    this.metrics?.userText();
    // New intent: stop any progress line, then start the new turn's timing.
    this.narration?.cancel();
    this.narration?.userTurnEnded();
    // A typed turn gets the same pointer context as a spoken one; it lands
    // before the text so the model reads "this" with its referent.
    this.beginPointerTurn?.('text');
    const itemEvent = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: cleanText }],
      },
    };
    this.sendRealtimeEvent(itemEvent, 'client.user_text');
    this.requestUserTextResponse();
  }

  /**
   * Draw a hard boundary at a typed command: everything the previous response
   * still had in flight is now stale.
   *
   * `cancelRadioHandoff({abortTools:true})` aborts tools already RUNNING, but
   * a function call belonging to the old response can still arrive afterwards
   * and would be dispatched — a stale `fly_to_location` mutating the map after
   * the operator typed "stop". Marking the response superseded refuses those
   * on arrival.
   *
   * The old response's queued follow-up confirmation is dropped for the same
   * reason: the deferred typed turn is the single answer now, and a leftover
   * follow-up would create a second, out-of-order one.
   * @returns {void}
   */
  supersedeActiveResponseForUserTurn() {
    if (this.activeResponseId) {
      this.supersededResponseIds.add(this.activeResponseId);
      // Bounded: only recent responses can still have calls in flight.
      while (this.supersededResponseIds.size > SUPERSEDED_RESPONSE_MEMORY) {
        this.supersededResponseIds.delete(
          this.supersededResponseIds.values().next().value,
        );
      }
    }
    this.pendingResponseInstructions = null;
  }

  /**
   * Whether a function call belongs to a response a newer user turn replaced.
   * @param {string|null} responseId Response the call was emitted under.
   * @returns {boolean} True when the call must not be dispatched.
   */
  isSupersededResponse(responseId) {
    return Boolean(responseId) && this.supersededResponseIds.has(responseId);
  }

  /**
   * Ask for an answer to a typed command without colliding with a response
   * already in flight.
   *
   * The Realtime API rejects a second concurrent `response.create`
   * (`conversation_already_has_active_response`) and the rejected turn is
   * simply lost, so the typed command would sit in the conversation with no
   * answer. Every other client trigger goes through `queueResponseCreate`;
   * this was the one path that fired straight out. Deferred rather than
   * dropped: the operator's own command still gets answered, once, when the
   * active response finishes.
   * @returns {void}
   */
  requestUserTextResponse() {
    if (
      this.responseActive ||
      this.responseCreatePending ||
      this.progressGenerating()
    ) {
      this.pendingUserTextResponse = true;
      this.debugLog('response.create.deferred_user_text', {
        responseActive: this.responseActive,
        responseCreatePending: this.responseCreatePending,
      });
      return;
    }
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.pendingUserTextResponse = false;
    this.responseCreatePending = true;
    const sent = this.sendRealtimeEvent(
      { type: 'response.create' },
      'client.response_create.user_text',
    );
    if (!sent) this.responseCreatePending = false;
  }

  ownsConversation(channel) {
    return this.dc === channel && channel?.readyState === 'open';
  }

  async handleRealtimeEvent(event) {
    const eventChannel = this.dc;
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const sessionEvent = realtimeSessionEvent(payload);
    if (sessionEvent) this.emitSessionEvent(sessionEvent);
    this.metrics?.serverEvent(payload);
    this.observeSpeech(payload);
    // Streaming deltas are skipped: their `.done` events carry the full text,
    // and logging every token spent the debug sink's per-minute write budget,
    // dropping later turns' records.
    if (!payload.type?.endsWith?.('.delta')) {
      this.debugLog('server.event', {
        type: payload.type,
        eventId: payload.event_id || null,
        responseId: payload.response_id || payload.response?.id || null,
        payload,
      });
    }

    if (payload.type === 'error') {
      // Barge-in and retraction events are best effort: the response or audio
      // they target may already have finished.
      // The client's own event id is echoed in error.event_id; the top-level
      // event_id is the server event's own id.
      const echoedId = payload.error?.event_id || null;
      if (echoedId && echoedId === this.progressResponse?.eventId) {
        // A rejected progress line is only a missed status update: release
        // the response slot so the real reply is not held back.
        this.progressResponse = null;
        this.debugLog('client.progress.rejected', {
          code: payload.error?.code || null,
        });
        this.resumeInBandResponses();
        return;
      }
      if (echoedId && this.bestEffortEventIds.delete(echoedId)) {
        this.debugLog('client.best_effort.rejected', {
          eventId: echoedId,
          code: payload.error?.code || null,
        });
        return;
      }
      if (payload.error?.code === 'conversation_already_has_active_response') {
        this.cancelRadioHandoff({ abortTools: true });
        this.responseActive = true;
        this.responseCreatePending = false;
        this.pendingResponseInstructions = null;
        // Never replay: the rejected turn is dropped, not retried. Re-arming
        // here is how one collision becomes the same sentence twice.
        this.pendingUserTextResponse = false;
        console.warn('[GEV Realtime] Skipped overlapping response.create');
        this.debugLog('response.create.skipped_active', {
          eventId: payload.event_id,
          activeResponseMessage: payload.error?.message || null,
        });
        this.setStatus('listening', 'Ask or command');
        return;
      }
      // A conversation.item.delete for a stale viewport screenshot can land
      // AFTER the server already truncated that item → an item_not_found error.
      // That's a benign race from our own housekeeping, not a session failure —
      // do NOT flip the demo to ERROR (M14). Match either the code or the echoed
      // event_id of a delete we issued.
      if (this.viewport.consumeDeleteError(payload)) {
        console.warn(
          '[GEV Realtime] Ignored stale viewport item_not_found',
          payload.error?.code || null,
        );
        this.debugLog('viewport_delete.item_not_found', {
          eventId: payload.event_id || null,
          code: payload.error?.code || null,
        });
        return;
      }
      this.responseActive = false;
      this.responseCreatePending = false;
      this.pendingResponseInstructions = null;
      this.pendingUserTextResponse = false;
      this.cancelRadioHandoff({ abortTools: true });
      this.reportError('Realtime API', payload.error, {
        eventId: payload.event_id,
        type: payload.error?.type,
        code: payload.error?.code,
        param: payload.error?.param,
        ...this.connectionDiagnostics(),
      });
      return;
    }

    if (
      payload.type ===
        'conversation.item.input_audio_transcription.completed' &&
      payload.usage
    ) {
      this.recordTranscriptionUsage?.(payload.usage);
      if (this.isSessionEnding()) return;
    }

    if (this.isProgressEvent(payload)) {
      this.handleProgressEvent(payload);
      return;
    }

    if (payload.type === 'input_audio_buffer.speech_started') {
      this.userTurnPending = true;
      this.pendingResponseInstructions = null;
      this.cancelRadioHandoff({ abortTools: true });
      this.setVoiceSpeaker('user');
      // Point-and-ask: read the pointer as speech starts (open mic), or reuse
      // the push-to-talk keydown snapshot, before the user audio commits.
      this.beginPointerTurn?.('speech_start');
    }
    this.updateResponseState(payload);
    // The spend cap may have just ended the session from inside the usage
    // accounting above. The connection is already closed, so stop here rather
    // than executing tool calls (map side effects) for a session that no longer
    // exists and whose results could never be sent back.
    if (this.isSessionEnding()) return;

    if (
      payload.type === 'response.done' &&
      this.radio.pendingRadioPlaybackResult
    ) {
      if (payload.response?.status !== 'completed' || this.userTurnPending) {
        this.radio.clearPendingPlayback();
        return;
      }
      // The first response.done closes the tool-call response. Only then may
      // the queued follow-up speak “Turning on the radio.” Keep the prepared
      // result pending until that distinct spoken response also completes.
      if (this.pendingResponseInstructions) {
        this.flushPendingResponse();
        return;
      }
      if (this.isRadioHandoffReserved()) {
        this.radio.deferHandoff();
        return;
      }
      await this.startPendingRadioHandoff();
      return;
    }

    const calls = extractFunctionCalls(payload);
    if (!calls.length) return;

    // Session-ending latch (spend cap). Function-call events arrive BEFORE the
    // response.done that carries usage, so tools can already be queued when the
    // cap trips. Refuse to dispatch any NEW tool once the session is ending —
    // its results could never be sent back anyway (the data channel is closed).
    // Spend-cap gate, at the dispatch site. `extractFunctionCalls` yields AT
    // MOST ONE call per event (one `response.function_call_arguments.done` or
    // one `response.output_item.done`), so this single check covers the whole
    // batch — there is no reachable mid-batch window, and a per-iteration
    // re-check would be untestable dead code. If the extractor ever returns
    // multiple calls, restore a per-iteration check inside the loop below.
    if (this.isSessionEnding()) {
      this.debugLog('voice.cost.cap.tools_skipped', { skipped: calls.length });
      return;
    }

    const toolResponseId = payload.response_id || payload.response?.id || null;
    // A newer typed command superseded the response these calls belong to.
    // They are stale intent — dispatching one would let the old turn mutate
    // the map after the operator asked for something else.
    //
    // Refusing is not the same as ignoring. Every function call MUST be
    // answered with a `function_call_output`: leaving one unanswered strands a
    // pending call in the conversation and deadlocks the model (the same
    // hazard `callDedupeKeys` is written to avoid). So each refused call gets
    // a terminal output saying plainly that the turn moved on. No
    // `response.create` follows — the deferred typed turn is the single answer.
    if (this.isSupersededResponse(toolResponseId)) {
      this.pruneProcessedCalls();
      for (const call of calls) {
        const keys = callDedupeKeys(call);
        if (keys.some((key) => this.processedCalls.has(key))) continue;
        keys.forEach((key) => this.processedCalls.set(key, performance.now()));
        this.sendToolOutput(call.call_id || call.id, {
          ok: false,
          action: call.name,
          superseded: true,
          error:
            'Superseded by a newer command from the operator — this call was not run.',
        });
      }
      this.debugLog('tool.call.skipped_superseded', {
        responseId: toolResponseId,
        skipped: calls.map((call) => call.name),
      });
      return;
    }

    this.setStatus('executing', 'Running command');
    this.pruneProcessedCalls();
    let sentOutput = false;
    let lastResult = null;
    let stopAfterRadioTool = false;
    for (const call of calls) {
      // No per-iteration spend-cap re-check here by design: `calls` holds at
      // most one entry (see the pre-loop gate above), so there is no mid-batch
      // window to guard. Restore one here if extractFunctionCalls ever returns
      // multiple calls.
      const keys = callDedupeKeys(call);
      if (keys.some((key) => this.processedCalls.has(key))) continue;
      keys.forEach((key) => this.processedCalls.set(key, performance.now()));

      let result;
      const resultChannel = this.dc;
      let radioHandoffEpochAtStart = this.radio.radioHandoffEpoch;
      let toolController = null;
      let radioOwnershipClaimed = false;
      let radioReservationToken = null;
      let isRadioFeatureCall = call.name === 'control_radio';
      const toolSpan = this.metrics?.toolStart(call.name);
      const narrationId =
        call.call_id || call.id || `tool-${++this.narrationSequence}`;
      if (this.speechResponseIds.has(toolResponseId))
        this.narration?.preamble();
      try {
        const parsedArguments = parseArguments(call.arguments);
        const isRadioControlCall = call.name === 'control_radio';
        const isRadioVisibilityCall =
          call.name === 'set_layer_visibility' &&
          parsedArguments.layerId === 'radio';
        isRadioFeatureCall = isRadioControlCall || isRadioVisibilityCall;
        const radioControlAction = isRadioControlCall
          ? String(parsedArguments.action || '').toLowerCase()
          : null;
        const radioAuthorityDomain =
          isRadioVisibilityCall ||
          ['enable', 'disable'].includes(radioControlAction)
            ? 'visibility'
            : radioControlAction === 'status'
              ? 'query'
              : isRadioControlCall
                ? 'playback'
                : null;
        radioOwnershipClaimed =
          (isRadioControlCall &&
            ['disable', 'pause', 'stop'].includes(radioControlAction)) ||
          (isRadioVisibilityCall && parsedArguments.enabled === false);
        if (radioOwnershipClaimed) {
          // Reserve authority by cancelling unsafe underlying work now, but do
          // not advance the committed handoff epoch until this action reports
          // semantic success. A failed stronger action must not suppress an
          // older sibling that already completed valid work.
          radioReservationToken = this.reserveRadioToolHandoff({
            abortScope:
              radioControlAction === 'disable' ||
              (isRadioVisibilityCall && parsedArguments.enabled === false)
                ? 'all'
                : 'playback',
          });
        }
        radioHandoffEpochAtStart = this.radio.radioHandoffEpoch;
        this.narration?.toolStarted(narrationId, {
          name: call.name,
          label: narrationLabel(call.name, parsedArguments),
          narrate: !isRadioFeatureCall && !SILENT_TOOLS.has(call.name),
        });
        this.debugLog('tool.call', {
          name: call.name,
          callId: call.call_id || call.id || null,
          arguments: parsedArguments,
        });
        toolController = new AbortController();
        // Function-call events from one assistant response can overlap. They
        // are siblings, not superseding turns, so only user-turn/session
        // cancellation aborts them as a group.
        this.activeToolAbortControllers.add(toolController);
        if (isRadioFeatureCall) {
          this.radio.registerTool(toolController, {
            responseId: toolResponseId,
            authorityDomain: radioAuthorityDomain,
          });
        }
        result = await (this.actionExecutor || this.runner)(
          call.name,
          parsedArguments,
          {
            signal: toolController.signal,
            callId: narrationId,
            progress: (update) => this.narration?.progress(narrationId, update),
            isCurrent: () =>
              this.activeToolAbortControllers.has(toolController) &&
              !this.userTurnPending &&
              this.dc === resultChannel &&
              resultChannel?.readyState === 'open' &&
              (radioAuthorityDomain !== 'playback' ||
                radioHandoffEpochAtStart === this.radio.radioHandoffEpoch),
          },
        );
        if (!this.ownsConversation(eventChannel)) return;
        if (result?.ok && result.radioPlaybackRequested) {
          const sessionIsCurrent =
            this.activeToolAbortControllers.has(toolController) &&
            !this.userTurnPending &&
            this.dc === resultChannel &&
            resultChannel?.readyState === 'open';
          const handoffIsCurrent =
            sessionIsCurrent &&
            radioHandoffEpochAtStart === this.radio.radioHandoffEpoch;
          const siblingStoppedPlayback = Boolean(
            sessionIsCurrent &&
            !handoffIsCurrent &&
            toolResponseId &&
            this.radio.radioHandoffCancellation?.epoch ===
              this.radio.radioHandoffEpoch &&
            this.radio.radioHandoffCancellation?.responseId === toolResponseId,
          );
          if (handoffIsCurrent) {
            this.radio.setPendingPlayback(result);
          } else if (siblingStoppedPlayback) {
            // A stop/pause/disable sibling owns the playback outcome, but it
            // does not revoke this tool's already-completed station mutation.
            const authoritativeRadioState =
              this.radioLayer?.getUIState?.() || {};
            const lifecycleSummary = readLayerLifecycleSummary(
              this.dataManager,
              'radio',
              {
                fallbackEnabled:
                  authoritativeRadioState.enabled ?? result.enabled,
              },
            );
            result = {
              ...result,
              radioPlaybackRequested: false,
              radioPlaybackSuppressed: true,
              ...lifecycleSummary,
              audioState:
                authoritativeRadioState.audioState ||
                result.audioState ||
                'stopped',
            };
          } else {
            result = {
              ...result,
              ok: false,
              radioPlaybackRequested: false,
              cancelled: true,
              error:
                'Radio request was superseded by a newer Radio control or voice turn',
            };
          }
        } else if (
          result?.ok &&
          result.action === 'control_radio' &&
          ['disable', 'pause', 'stop'].includes(result.radioAction)
        ) {
          if (!radioOwnershipClaimed) {
            this.cancelRadioHandoff({
              abortRadioSiblings: result.radioAction === 'stop',
              responseId: toolResponseId,
            });
          }
        }
      } catch (error) {
        const authoritativeRadioState = isRadioFeatureCall
          ? this.radioLayer?.getUIState?.() || {}
          : null;
        result = {
          ok: false,
          error: error?.message || 'GEV command failed',
          tool: call.name,
          ...(isRadioFeatureCall
            ? readLayerLifecycleSummary(this.dataManager, 'radio', {
                fallbackEnabled: authoritativeRadioState?.enabled,
              })
            : {}),
        };
      } finally {
        if (toolController) {
          this.activeToolAbortControllers.delete(toolController);
          this.radio.releaseTool(toolController);
        }
        this.metrics?.toolEnd(toolSpan, result?.ok);
        this.narration?.toolFinished(narrationId);
      }
      // Rejections also arrive after cancellation; never publish into a new session.
      if (!this.ownsConversation(eventChannel)) return;
      if (radioReservationToken && result?.ok) {
        // Successful authority commits before its output is serialized. The
        // sibling abort synchronously restores manager ownership, so report
        // that settled authoritative state instead of the transient state the
        // control observed while the older auto-enable was still pending.
        this.settleRadioToolHandoffReservation(radioReservationToken, {
          commit: true,
          responseId: toolResponseId,
        });
        radioReservationToken = null;
        const authoritativeRadioState = this.radioLayer?.getUIState?.() || {};
        const lifecycleSummary = readLayerLifecycleSummary(
          this.dataManager,
          'radio',
          {
            fallbackEnabled: authoritativeRadioState.enabled ?? result.enabled,
          },
        );
        result = {
          ...result,
          ...lifecycleSummary,
          audioState: authoritativeRadioState.audioState || result.audioState,
          ...(result.radioAction === 'pause' &&
          lifecycleSummary.enabled === false
            ? { changed: false }
            : {}),
        };
      }
      this.debugLog('tool.result', {
        name: call.name,
        callId: call.call_id || call.id || null,
        result,
      });
      lastResult = result;
      stopAfterRadioTool =
        stopAfterRadioTool ||
        (shouldStopVoiceAfterRadioTool(result) &&
          !result.radioPlaybackRequested &&
          !result.radioPlaybackSuppressed);
      sentOutput =
        this.sendToolOutput(call.call_id || call.id, result) || sentOutput;
      if (radioReservationToken) {
        // Only failed stronger actions reach this branch. Release after their
        // tool output so resumed playback cannot close the voice channel
        // before the failure is reported.
        this.settleRadioToolHandoffReservation(radioReservationToken, {
          commit: false,
          responseId: toolResponseId,
        });
      }
    }
    if (stopAfterRadioTool) {
      this.stop();
      return;
    }
    if (sentOutput && this.dc?.readyState === 'open') {
      // The viewport-image send is best-effort context. It must never block the
      // response — a throw here would strand the turn at EXECUTING (M13). Guard
      // it so queueResponseCreate always runs, image or not.
      try {
        await this.sendVisualContextIfUseful(lastResult);
      } catch (error) {
        this.debugLog('viewport_context.failed', {
          error: error?.message || String(error),
        });
      }
      if (!this.ownsConversation(eventChannel)) return;
      // Keep the Radio handoff wording authoritative even when another tool
      // result follows Radio in the same multi-intent response.
      this.queueResponseCreate(
        responseInstructionForToolResult(
          this.radio.pendingRadioPlaybackResult || lastResult,
        ),
      );
    }
    this.setStatus('listening', 'Ask or command');
  }

  /**
   * Track what the user can hear: assistant audio start/stop, which
   * in-band responses spoke before a tool call (preambles), and playback of
   * the out-of-band progress line.
   * @param {object} payload Server event.
   */
  observeSpeech(payload) {
    const type = payload?.type;
    const responseId = payload?.response_id || payload?.response?.id || null;
    const progress = this.progressResponse;
    const isProgress = Boolean(
      responseId && this.progressResponseIds.has(responseId),
    );
    if (type === 'input_audio_buffer.speech_started') {
      // New intent: narration stops, including a line already playing.
      this.narration?.cancel();
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.narration?.userTurnEnded();
      return;
    }
    if (
      type === 'response.output_audio_transcript.delta' &&
      responseId &&
      !isProgress
    ) {
      this.speechResponseIds.add(responseId);
      while (this.speechResponseIds.size > SPEECH_RESPONSE_MEMORY)
        this.speechResponseIds.delete(
          this.speechResponseIds.values().next().value,
        );
      return;
    }
    if (type === 'output_audio_buffer.started') {
      this.assistantAudioPlaying = true;
      if (progress && progress.id === responseId) {
        progress.audible = true;
        progress.playing = true;
      }
      this.narration?.audible();
      return;
    }
    if (
      type === 'output_audio_buffer.stopped' ||
      type === 'output_audio_buffer.cleared'
    ) {
      this.assistantAudioPlaying = false;
      // Playback ownership ends here, not at response.done: a line keeps
      // playing after its generation completes.
      if (progress && (progress.id === responseId || !responseId)) {
        progress.playing = false;
        if (!progress.generating) this.progressResponse = null;
      }
      this.narration?.quiet();
    }
  }

  /** Whether an event belongs to an out-of-band progress response. */
  isProgressEvent(payload) {
    const responseId = payload?.response_id || payload?.response?.id || null;
    if (payload?.response?.metadata?.gev === PROGRESS_RESPONSE_TAG) return true;
    return Boolean(responseId && this.progressResponseIds.has(responseId));
  }

  /**
   * Progress responses live outside the conversation's response lifecycle:
   * they never set or clear the active in-band response, never touch Radio
   * handoff state, and only release queued in-band replies when their
   * generation ends. Their usage is still billed.
   */
  handleProgressEvent(payload) {
    const responseId = payload.response_id || payload.response?.id || null;
    const progress = this.progressResponse;
    if (payload.type === 'response.created') {
      if (responseId) {
        this.progressResponseIds.add(responseId);
        while (this.progressResponseIds.size > SPEECH_RESPONSE_MEMORY)
          this.progressResponseIds.delete(
            this.progressResponseIds.values().next().value,
          );
      }
      if (progress && progress.id === null) {
        progress.id = responseId;
        if (progress.retracted || progress.stopped)
          this.cancelResponse(responseId);
      }
      return;
    }
    if (payload.type !== 'response.done') return;
    this.recordUsage(payload.response?.usage);
    if (progress && progress.id === responseId) {
      progress.generating = false;
      if (!progress.playing) this.progressResponse = null;
    }
    this.resumeInBandResponses();
  }

  /** Whether a progress line is still being generated. */
  progressGenerating() {
    return Boolean(this.progressResponse?.generating);
  }

  /** Release an in-band reply that waited behind a progress line. */
  resumeInBandResponses() {
    if (this.progressGenerating()) return;
    if (this.pendingUserTextResponse) this.requestUserTextResponse();
    else this.flushPendingResponse();
  }

  /** Whether a progress line may start now without talking over anyone. */
  canNarrate() {
    return Boolean(
      this.dc?.readyState === 'open' &&
      !this.responseActive &&
      !this.responseCreatePending &&
      !this.userTurnPending &&
      !this.assistantAudioPlaying &&
      !this.progressResponse &&
      this.radio.mayVoiceClaimSpeaker() &&
      !this.isSessionEnding(),
    );
  }

  /**
   * Speak one progress line out of band: outside the conversation (so the
   * prompt cache and history are untouched), with tools disabled and a
   * small output bound.
   * @param {string} line Code-authored line.
   * @returns {boolean} Whether the request was sent.
   */
  speakProgressLine(line) {
    if (!line || !this.canNarrate()) return false;
    const eventId = `gev_progress_${++this.bestEffortSequence}`;
    const sent = this.sendRealtimeEvent(
      {
        type: 'response.create',
        event_id: eventId,
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          tool_choice: 'none',
          max_output_tokens: PROGRESS_MAX_OUTPUT_TOKENS,
          metadata: { gev: PROGRESS_RESPONSE_TAG },
          instructions: PROGRESS_INSTRUCTIONS,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: line }],
            },
          ],
        },
      },
      'client.response_create.progress',
    );
    if (!sent) return false;
    this.progressResponse = {
      id: null,
      eventId,
      generating: true,
      audible: false,
      playing: false,
      retracted: false,
      stopped: false,
    };
    return true;
  }

  /**
   * The tool finished: drop a line nobody has heard yet, and let one that is
   * already audible finish.
   */
  retractProgressLine() {
    const progress = this.progressResponse;
    if (!progress || progress.audible || !progress.generating) return;
    progress.retracted = true;
    if (progress.id) this.cancelResponse(progress.id);
  }

  /** New intent: stop the progress line, audible or not. */
  stopProgressLine() {
    const progress = this.progressResponse;
    if (!progress || progress.stopped) return;
    progress.stopped = true;
    if (progress.generating && progress.id) this.cancelResponse(progress.id);
    if (progress.playing) {
      this.sendBestEffort(
        { type: 'output_audio_buffer.clear' },
        'client.output_audio_clear',
      );
    }
  }

  /** Send a client event whose rejection is expected and harmless. */
  sendBestEffort(message, logEventName) {
    const eventId = `gev_be_${++this.bestEffortSequence}`;
    this.bestEffortEventIds.add(eventId);
    while (this.bestEffortEventIds.size > 16)
      this.bestEffortEventIds.delete(
        this.bestEffortEventIds.values().next().value,
      );
    return this.sendRealtimeEvent(
      { ...message, event_id: eventId },
      logEventName,
    );
  }

  cancelResponse(responseId) {
    return this.sendBestEffort(
      {
        type: 'response.cancel',
        ...(responseId ? { response_id: responseId } : {}),
      },
      'client.response_cancel',
    );
  }

  /**
   * Explicit barge-in (a claimed Space hold while the assistant speaks):
   * cancel the reply and clear queued audio, the documented WebRTC
   * interruption; the server truncates the item to what was played. Drops
   * narration and any queued follow-up. Tools keep running; the user's new
   * speech supersedes them as usual. Refused while Radio holds the speaker
   * (prepared, reserved or starting playback), so that takeover stays intact.
   * @returns {boolean} Whether anything was interrupted.
   */
  bargeIn() {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    const speaking =
      this.assistantAudioPlaying ||
      this.responseActive ||
      Boolean(this.progressResponse);
    if (!speaking) return false;
    if (!this.radio.mayVoiceClaimSpeaker()) return false;
    const responseId = this.activeResponseId;
    const audioPlaying = this.assistantAudioPlaying;
    this.narration?.cancel();
    this.metrics?.bargeIn();
    this.pendingResponseInstructions = null;
    if (this.responseActive) {
      this.supersedeActiveResponseForUserTurn();
      this.cancelResponse(responseId);
    }
    if (audioPlaying) {
      this.sendBestEffort(
        { type: 'output_audio_buffer.clear' },
        'client.output_audio_clear',
      );
    }
    this.debugLog('voice.barge_in', { responseId, audioPlaying });
    return true;
  }

  sendToolOutput(callId, result) {
    if (!callId || !this.dc || this.dc.readyState !== 'open') return false;
    this.sendRealtimeEvent(
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      },
      'client.function_call_output',
    );
    return true;
  }

  pruneProcessedCalls() {
    const cutoff = performance.now() - CALL_DEDUPE_MS;
    for (const [key, timestamp] of this.processedCalls) {
      if (timestamp < cutoff) this.processedCalls.delete(key);
    }
  }

  updateResponseState(payload) {
    if (payload.type === 'response.created') {
      this.responseActive = true;
      this.responseCreatePending = false;
      this.userTurnPending = false;
      this.activeResponseId =
        payload.response?.id || payload.response_id || null;
      this.setVoiceSpeaker('ai');
      return;
    }
    if (payload.type === 'response.done') {
      this.responseActive = false;
      this.responseCreatePending = false;
      this.activeResponseId = null;
      // Cost accounting first: `response.done` is the only event carrying token
      // usage, and this runs before the radio-handoff early-return upstream, so
      // no billed response escapes the meter.
      this.recordUsage(payload.response?.usage);
      const responseStatus = payload.response?.status;
      // The data-channel completion can arrive before WebRTC has drained its
      // final audio packets. Return the UI styling to idle now, but keep the
      // meter on the remote stream until the next user turn or session stop.
      this.setVoiceSpeaker('idle', { keepVisualizerSpeaker: true });
      // A failed response is otherwise swallowed here — the assistant just goes
      // mute with no feedback (H9/H3). Surface the reason so the user knows why.
      if (responseStatus === 'failed') {
        const details = payload.response?.status_details || null;
        const failErr = details?.error || null;
        this.reportError('Realtime response failed', failErr, {
          responseId: payload.response?.id || payload.response_id || null,
          statusReason: details?.reason || null,
          type: failErr?.type || null,
          code: failErr?.code || null,
          ...this.connectionDiagnostics(),
        });
        // Don't trap the whole session in 'error' for one bad response — the
        // connection is still live. Recover to listening so the user can retry
        // (mirrors the transient-blip philosophy, H8).
        if (this.dc?.readyState === 'open') {
          this.setStatus('listening', 'Ask or command');
        }
      }
      if (!this.radio.pendingRadioPlaybackResult) {
        // A typed command deferred behind this response is the operator's own
        // turn — answer it before any tool-result follow-up.
        if (this.pendingUserTextResponse) this.requestUserTextResponse();
        else this.flushPendingResponse();
      }
      return;
    }
    if (payload.type?.startsWith?.('response.') && payload.response_id) {
      this.responseActive = true;
      this.pauseRadioForVoice();
    }
  }

  queueResponseCreate(instructions) {
    if (this.userTurnPending) {
      this.debugLog('response.create.skipped_user_turn', {
        instructions: instructions || null,
      });
      return;
    }
    this.pendingResponseInstructions =
      instructions || 'Briefly respond once. Do not repeat yourself.';
    if (!this.responseActive && !this.responseCreatePending)
      this.flushPendingResponse();
  }

  flushPendingResponse() {
    if (
      !this.pendingResponseInstructions ||
      this.responseActive ||
      this.responseCreatePending ||
      this.progressGenerating() ||
      this.userTurnPending ||
      !this.dc ||
      this.dc.readyState !== 'open'
    )
      return;
    const instructions = this.pendingResponseInstructions;
    this.pendingResponseInstructions = null;
    this.responseCreatePending = true;
    const sent = this.sendRealtimeEvent(
      {
        type: 'response.create',
        response: { instructions },
      },
      'client.response_create.tool_followup',
    );
    if (!sent) this.responseCreatePending = false;
  }

  abortTools() {
    for (const controller of this.activeToolAbortControllers)
      controller.abort();
    this.activeToolAbortControllers.clear();
    this.radio.clearTools();
  }

  reset() {
    this.processedCalls.clear();
    this.responseActive = false;
    this.responseCreatePending = false;
    this.userTurnPending = false;
    this.pendingResponseInstructions = null;
    this.pendingUserTextResponse = false;
    this.activeResponseId = null;
    this.supersededResponseIds.clear();
    this.narration?.cancel();
    this.assistantAudioPlaying = false;
    this.speechResponseIds.clear();
    this.progressResponse = null;
    this.progressResponseIds.clear();
    this.bestEffortEventIds.clear();
  }
}
