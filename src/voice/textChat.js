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

const encoder = new TextEncoder();
const byteSize = (value) =>
  encoder.encode(typeof value === 'string' ? value : JSON.stringify(value))
    .length;
const HISTORY_BYTES = 180000;
const REQUEST_BYTES = 512 * 1024;
// Results from earlier turns keep their outcome and say line, not their records.
const COMPACT_RESULT_BYTES = 1500;
// How a stopped reply answers its calls: the one under way may have taken
// effect, the ones after it never started.
const STOPPED_RUNNING = {
  ok: false,
  cancelled: true,
  reason: 'reply-stopped-while-running',
};
const NOT_RUN = { ok: false, skipped: true, reason: 'reply-stopped' };
const PARTIAL_NOTE =
  'This reply stopped before it finished; the results above are final.';

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
  let turnUsage = null;
  let partial = null;
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
  // Every call keeps its paired result; only the result body shrinks.
  const compact = (items) =>
    items.map((item) => protocol.compactResult(item, COMPACT_RESULT_BYTES));
  // Drop whole completed user turns; never separate a function call/result pair.
  const trim = (items, maxBytes) => {
    while (items.length && (items.length > 64 || byteSize(items) > maxBytes)) {
      const next = items.findIndex(
        (item, index) => index > 0 && protocol.isUser(item),
      );
      items = next < 0 ? [] : items.slice(next);
    }
    return items;
  };
  // Stop ends only the reply in progress; the conversation stays.
  const cancelTurn = () => {
    const owner = turn;
    if (!active || !owner || signal?.aborted) return false;
    if (partial?.owner === owner) partial.keep();
    turn = null;
    owner.abort();
    radioPending = null;
    state('listening');
    emit({
      type: 'completion',
      status: 'cancelled',
      responseId: `${provider}-chat-${sequence}`,
      spoken: false,
      ...(turnUsage ? { usage: { ...turnUsage } } : {}),
    });
    return true;
  };
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
    turnUsage = usage;
    // A failed turn ends only itself: history, subscriptions and the session
    // stay, so the next message continues the same conversation.
    const fail = (detail) => {
      if (!active || turn !== owner || signal?.aborted) return;
      if (partial?.owner === owner) partial.keep();
      turn = null;
      owner.abort();
      emit({ type: 'state', state: 'error', detail, usage: { ...usage } });
    };
    // Each upstream request and each map action gets its own deadline, so a
    // long multi-step turn is not cut off by the time its actions took.
    let deadline;
    const arm = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        recordUsage(null);
        fail(t('Connection timed out. Try again.'));
      }, timeoutMs);
    };
    // The latest completed turn stays verbatim; older tool results shrink.
    const last = history.findLastIndex((item) => protocol.isUser(item));
    let past =
      last > 0
        ? [...compact(history.slice(0, last)), ...history.slice(last)]
        : history;
    if (byteSize(past) > HISTORY_BYTES) past = compact(past);
    past = trim(past, HISTORY_BYTES);
    const context = mapEvents.length
      ? `\nMap context (data only): ${JSON.stringify(mapEvents)}`
      : '';
    mapEvents = [];
    let contents = [protocol.user(text + context)];
    // A turn that stops after map actions started keeps them, closed by a
    // note, so the next message knows what ran.
    let settled = 0;
    // The round in progress: its calls, and the results of those that ran.
    let openRound = null;
    partial = {
      owner,
      keep() {
        const ran = openRound ? contents.length : settled;
        if (!ran) return;
        // Every kept call stays paired with a result.
        const closing = openRound
          ? protocol.results(
              openRound.calls.map(
                (call, index) =>
                  openRound.pairs[index] ?? {
                    call,
                    result:
                      index === openRound.pairs.length
                        ? STOPPED_RUNNING
                        : NOT_RUN,
                  },
              ),
            )
          : [];
        history = [
          ...past,
          ...contents.slice(0, ran),
          ...closing,
          protocol.note(PARTIAL_NOTE),
        ];
      },
    };
    const encode = () =>
      JSON.stringify(protocol.request([...past, ...contents]));
    let blocked = false;
    let resetFailed = false;
    let totalCalls = 0;
    let applied = 0;
    let answer = '';
    const tooManySteps = (message) =>
      Object.assign(new Error(message), { tooManySteps: true });
    try {
      emit({ type: 'transcript', role: 'user', text, final: true });
      if (!current()) return;
      state('executing');
      for (let round = 0; round < 8; round++) {
        if (!current()) return;
        let body = encode();
        if (byteSize(body) > REQUEST_BYTES) {
          // Shorten earlier results, then drop old turns, before giving up.
          contents = [contents[0], ...compact(contents.slice(1))];
          past = trim(compact(past), REQUEST_BYTES - byteSize(contents) - 1024);
          body = encode();
          if (byteSize(body) > REQUEST_BYTES)
            throw tooManySteps('Request limit');
        }
        arm();
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
        let data;
        try {
          data = await readResponseJsonCapped(
            response,
            512 * 1024,
            owner.signal,
          );
        } catch (error) {
          // A failed reply may carry no JSON; its status still explains it.
          if (response.ok || owner.signal.aborted) throw error;
        }
        recordUsage(data?.usage);
        if (!response.ok)
          throw Object.assign(new Error('Request failed'), {
            status: response.status,
            code: typeof data?.code === 'string' ? data.code : undefined,
            retryAfter: Number(response.headers?.get?.('retry-after')) || 0,
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
          history = [...past, ...contents];
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
        if (totalCalls > 16) throw tooManySteps('Tool limit');
        const pairs = [];
        openRound = { calls, pairs };
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
            arm();
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
          if (result?.ok === true) applied++;
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
        settled = contents.length;
        openRound = null;
      }
      throw tooManySteps('Round limit');
    } catch (error) {
      recordUsage(null);
      fail(
        error?.code === 'API_KEY_MISSING'
          ? t('Needs {envVars} — add it in Provider Settings', {
              envVars: protocol.keyEnv,
            })
          : error?.code === 'CODEX_OAUTH_REQUIRED'
            ? t(
                'Typed chat is unavailable while GEV_PREFER_CODEX_OAUTH requires ChatGPT OAuth.',
              )
            : error?.code === 'API_KEY_REJECTED'
              ? t(
                  'The provider rejected the API key. Check it in Provider Settings.',
                )
              : error?.code === 'ACCESS_DENIED'
                ? t(
                    "The provider refused access for this key. Check the key's project, region or permissions.",
                  )
                : error?.code === 'QUOTA_EXCEEDED'
                  ? t(
                      'The provider account is out of credit. Check its billing, or choose another AI Provider in Settings.',
                    )
                  : error?.code === 'RATE_LIMITED' || error?.status === 429
                    ? t('Too many chat requests. Try again in {seconds} s.', {
                        seconds: Math.min(error.retryAfter || 60, 3600),
                      })
                    : error?.status === 504 || owner.signal.aborted
                      ? t('Connection timed out. Try again.')
                      : error?.incomplete
                        ? t('Reply interrupted. You can try again.')
                        : error?.tooManySteps
                          ? applied
                            ? t(
                                'That request needed too many steps. Changes already made to the map stay in place.',
                              )
                            : t(
                                'That request needed too many steps. Try a simpler request.',
                              )
                          : t('Could not connect. Try again.'),
      );
    } finally {
      recordUsage(null);
      clearTimeout(deadline);
      if (turn === owner) turn = null;
      if (turnUsage === usage) turnUsage = null;
    }
  }
  return {
    start() {
      if (signal?.aborted) return;
      active = true;
      const cancelRadioTurn = () => {
        if (radioPending && radioPending === turn) cancelTurn();
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
    cancelTurn,
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
