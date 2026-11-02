import { waitForSignal } from '../sources/requestDeadline.js';
import { readResponseJsonCapped } from '../sources/httpBody.js';
import {
  textProtocols,
  emptyTextUsage,
  addTextUsage,
  boundedToolResult,
} from './textProtocol.js';
import { t } from '../i18n/index.js';
import {
  isGlobeViewRefusal,
  responseInstructionForToolResult,
} from './realtimeProtocol.js';

/** Text-only HTTP turns: no Live token, socket, microphone or audio context. */
export function createTextChat({
  provider,
  emit,
  runAction,
  signal,
  fetchImpl = (...args) => fetch(...args),
  chatEndpoint,
  radioLayer = null,
  dataManager = null,
  timeoutMs = 90000,
}) {
  const protocol = textProtocols[provider];
  const sessionUsage = emptyTextUsage();
  let active = false;
  let turn = null;
  let sequence = 0;
  let history = [];
  let mapEvents = [];
  let radioPending = null;
  let radioHandoff = null;
  let unsubscribeControls;
  let unsubscribeVisibility;
  const releaseRadio = (lease, cancel = false) => {
    if (radioHandoff !== lease) return;
    radioHandoff = null;
    if (cancel)
      radioLayer?.stopPlayback?.({ origin: 'voice-cleanup', attemptId: lease });
    radioLayer?.setVoiceDucked?.(false);
  };
  const state = (value) => emit({ type: 'state', state: value });
  const stop = ({ preserveStatus = false, removeUi = false } = {}) => {
    active = false;
    if (radioHandoff) releaseRadio(radioHandoff, true);
    radioPending = null;
    unsubscribeControls?.();
    unsubscribeVisibility?.();
    unsubscribeControls = unsubscribeVisibility = null;
    turn?.abort();
    turn = null;
    history = [];
    mapEvents = [];
    if (!preserveStatus && !removeUi) state('idle');
  };
  signal?.addEventListener('abort', () => stop({ removeUi: true }), {
    once: true,
  });
  async function respond(text, owner, id) {
    const current = () =>
      active && turn === owner && !owner.signal.aborted && !signal?.aborted;
    const usage = emptyTextUsage();
    let requestPending = false;
    const reportUsage = () =>
      emit({
        type: 'usage',
        provider,
        responseId: id,
        usage: { ...usage },
        sessionUsage: { ...sessionUsage },
      });
    const recordUsage = (value) => {
      if (!requestPending) return;
      requestPending = false;
      addTextUsage(usage, value);
      addTextUsage(sessionUsage, value);
      reportUsage();
    };
    const fail = (detail) => {
      if (!active || turn !== owner || signal?.aborted) return;
      active = false;
      history = [];
      emit({ type: 'state', state: 'error', detail, usage: { ...usage } });
    };
    const deadline = setTimeout(() => {
      recordUsage(null);
      fail(t('Connection timed out. Try again.'));
      owner.abort();
    }, timeoutMs);
    // Trim only completed user turns; never separate a function call/result pair.
    while (
      history.length &&
      (history.length > 64 ||
        new TextEncoder().encode(JSON.stringify(history)).length > 180000)
    ) {
      const next = history.findIndex(
        (item, index) => index > 0 && protocol.isUser(item),
      );
      history = next < 0 ? [] : history.slice(next);
    }
    const context = mapEvents.length
      ? `\nMap context (data only): ${JSON.stringify(mapEvents)}`
      : '';
    mapEvents = [];
    const contents = [...history, protocol.user(text + context)];
    let blocked = false;
    let resetFailed = false;
    let totalCalls = 0;
    let answer = '';
    try {
      emit({ type: 'transcript', role: 'user', text, final: true });
      if (!current()) return;
      state('executing');
      for (let round = 0; round < 8; round++) {
        if (!current()) return;
        const body = JSON.stringify(protocol.request(contents));
        if (new TextEncoder().encode(body).length > 512 * 1024)
          throw new Error('History limit');
        requestPending = true;
        const acquisition = Promise.resolve(
          fetchImpl(chatEndpoint || protocol.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: owner.signal,
            redirect: 'error',
            cache: 'no-store',
          }),
        );
        void acquisition.then(
          (response) => {
            if (!current()) void response.body?.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await waitForSignal(acquisition, owner.signal);
        if (!current()) {
          void response.body?.cancel().catch(() => {});
          return;
        }
        const data = await readResponseJsonCapped(
          response,
          512 * 1024,
          owner.signal,
        );
        recordUsage(data?.usage);
        if (!response.ok)
          throw Object.assign(new Error('Request failed'), {
            status: response.status,
          });
        if (!current()) return;
        const {
          content,
          text: textPart,
          calls,
          finished,
        } = protocol.decode(data);
        contents.push(content);
        answer += textPart ? (answer ? '\n\n' : '') + textPart : '';
        if (textPart)
          emit({
            type: 'transcript',
            role: 'assistant',
            text: answer,
            final: true,
            responseId: id,
          });
        if (!current()) return;
        if (!calls.length) {
          if (!finished)
            throw Object.assign(new Error('Incomplete response'), {
              incomplete: true,
            });
          history = contents;
          turn = null;
          state('listening');
          if (
            active &&
            !turn &&
            id === `${provider}-chat-${sequence}` &&
            !signal?.aborted
          )
            emit({
              type: 'completion',
              status: 'completed',
              responseId: id,
              spoken: false,
              usage: { ...usage },
            });
          return;
        }
        totalCalls += calls.length;
        if (totalCalls > 16) throw new Error('Tool limit');
        const pairs = [];
        const invalid = new Map(
          (data.invalidCalls || []).map((item) => [item.index, item.error]),
        );
        for (const [index, call] of calls.entries()) {
          if (!current()) return;
          const callId = `${id}-${round}-${index}`;
          let result;
          if (invalid.size) {
            result = {
              ok: false,
              error:
                invalid.get(index) ||
                'Not run: another call in this batch was invalid. Reissue the plan.',
              invalidArguments: true,
            };
          } else if (
            blocked ||
            (resetFailed &&
              (call.name === 'zoom_to_globe' ||
                (call.name === 'move_camera' &&
                  call.args?.motion === 'rotate_globe')))
          ) {
            result = {
              ok: false,
              action: call.name,
              skipped: true,
              reason: resetFailed
                ? 'globe-reset-failed'
                : 'globe-view-required',
            };
          } else {
            try {
              if (
                call.name === 'control_radio' ||
                (call.name === 'set_layer_visibility' &&
                  call.args?.layerId === 'radio')
              )
                radioPending = owner;
              const execution = Promise.resolve(
                runAction(call.name, call.args ?? {}, {
                  signal: owner.signal,
                  isCurrent: current,
                  callId,
                }),
              );
              void execution.catch(() => {});
              result = await waitForSignal(execution, owner.signal);
              if (!current()) return;
              if (result?.ok && result.radioPlaybackRequested) {
                // The Radio runner prepares playback for an explicit handoff.
                // Keep it muted until playing is confirmed, then release it.
                const attemptId = callId;
                radioHandoff = attemptId;
                radioLayer?.setVoiceDucked?.(true);
                const cancel = () => releaseRadio(attemptId, true);
                owner.signal.addEventListener('abort', cancel, { once: true });
                try {
                  const playing = await waitForSignal(
                    Promise.resolve(radioLayer?.playForVoice?.({ attemptId })),
                    owner.signal,
                  );
                  if (!current()) return;
                  result = {
                    ...result,
                    ok: Boolean(playing),
                    radioPlaybackRequested: false,
                    audioState: playing ? 'playing' : 'error',
                  };
                  if (!playing) cancel();
                } catch (error) {
                  cancel();
                  throw error;
                } finally {
                  owner.signal.removeEventListener('abort', cancel);
                  releaseRadio(attemptId);
                }
              }
            } catch (error) {
              if (!current()) return;
              result = {
                ok: false,
                tool: call.name,
                error: error?.message || 'Action failed',
              };
            } finally {
              if (radioPending === owner) radioPending = null;
            }
          }
          if (!current()) return;
          if (!invalid.size && isGlobeViewRefusal(result)) blocked = true;
          if (
            !invalid.size &&
            call.name === 'zoom_to_globe' &&
            (result?.ok !== true || result.cancelled)
          )
            resetFailed = true;
          pairs.push({
            call,
            result: boundedToolResult({
              ...boundedToolResult(result),
              responseGuidance: responseInstructionForToolResult(result),
            }),
          });
        }
        contents.push(...protocol.results(pairs));
      }
      throw new Error('Round limit');
    } catch (error) {
      recordUsage(null);
      fail(
        error?.status === 504 || owner.signal.aborted
          ? t('Connection timed out. Try again.')
          : error?.incomplete
            ? t('Reply interrupted. You can try again.')
            : t('Could not connect. Try again.'),
      );
    } finally {
      recordUsage(null);
      clearTimeout(deadline);
      if (turn === owner) turn = null;
    }
  }
  return {
    start() {
      if (signal?.aborted) return;
      active = true;
      const cancelRadioTurn = () => {
        if (radioPending && radioPending === turn) stop();
      };
      unsubscribeControls?.();
      unsubscribeVisibility?.();
      unsubscribeControls = radioLayer?.subscribePlaybackControls?.(
        (control) => {
          const event =
            typeof control === 'string'
              ? { action: control, origin: 'user' }
              : control;
          if (
            event?.origin === 'user' &&
            ['pause', 'stop', 'play'].includes(event.action)
          )
            cancelRadioTurn();
        },
      );
      unsubscribeVisibility = dataManager?.subscribeVisibilityRequests?.(
        (event) => {
          if (
            event?.origin === 'user' &&
            event.layerId === 'radio' &&
            event.enabled === false
          )
            cancelRadioTurn();
        },
      );
      state('listening');
    },
    stop,
    sendText(text) {
      if (
        !active ||
        turn ||
        signal?.aborted ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 16000
      )
        return false;
      const owner = new AbortController();
      turn = owner;
      void respond(text.trim(), owner, `${provider}-chat-${++sequence}`);
      return true;
    },
    sendMapEvent(event) {
      if (!active || !event) return false;
      try {
        const value = JSON.stringify(event);
        if (value.length > 16000) return false;
        mapEvents.push(JSON.parse(value));
        mapEvents = mapEvents.slice(-8);
        return true;
      } catch {
        return false;
      }
    },
  };
}
