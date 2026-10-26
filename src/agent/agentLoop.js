import { fitHistoryToBytes, toolResultMessage } from './conversation.js';

/**
 * Drives one typed command to completion in the browser.
 *
 * The tools mutate the Cesium viewer, so they can only run here; the server
 * holds the credentials, so the model can only be reached there. That splits
 * one logical turn into a loop: ask the server, run whatever tool calls come
 * back, hand the results forward, ask again. The loop ends when the model
 * answers with prose instead of a call.
 *
 * `fetchImpl` and `runAction` are both injected, so the whole loop is testable
 * without a network or a globe.
 */

/** Endpoint the loop posts to. */
const AGENT_COMMAND_ENDPOINT = '/api/agent/command';

/**
 * Tool rounds allowed for one typed command.
 *
 * The manual encourages multi-tool turns ("call ALL the corresponding tools"),
 * so this is not 1; it is a runaway guard for a model that keeps calling tools
 * and never answers.
 */
const MAX_TOOL_ROUNDS = 8;

/**
 * Transcript budget for one request.
 *
 * Below the server's own 512 KB body cap, so a long session trims itself here
 * rather than failing every command at once with a 413 that the console
 * cannot explain.
 */
const MAX_REQUEST_HISTORY_BYTES = 448 * 1024;

/** Lifecycle events emitted for the console to render. */
const AGENT_EVENTS = Object.freeze({
  REQUEST: 'request',
  TOOL_START: 'tool-start',
  TOOL_RESULT: 'tool-result',
  MESSAGE: 'message',
  WARNING: 'warning',
  ERROR: 'error',
  DONE: 'done',
});

/** A zeroed usage accumulator. */
function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, requests: 0 };
}

/**
 * Accumulate token usage across a session.
 *
 * Providers vary in which fields they populate, so an absent counter stays
 * zero rather than being inferred from the others.
 */
function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  return {
    promptTokens: total.promptTokens + (Number(usage.prompt_tokens) || 0),
    completionTokens:
      total.completionTokens + (Number(usage.completion_tokens) || 0),
    requests: total.requests + 1,
  };
}

/**
 * Run one action and reduce whatever it throws into a tool result.
 *
 * A thrown action must not abort the loop: the model is told to report partial
 * failure honestly, and it can only do that if the failure reaches it as a
 * result rather than as a dead session.
 */
async function runActionSafely(runAction, name, args, signal) {
  try {
    signal.throwIfAborted();
    const result = await runAction(name, args, {
      signal,
      isCurrent: () => !signal.aborted,
    });
    return result === undefined ? { ok: true, action: name } : result;
  } catch (error) {
    return {
      ok: false,
      action: name,
      error: error?.message || 'Action threw an unexpected error',
    };
  }
}

// End this typed request locally on a globe refusal. Another model round
// could otherwise turn the suggested reset command into fresh tool intent.
// Use fixed text, never tool-supplied strings as instructions.
function cameraRefusalReply(name, args, result) {
  if (name === 'zoom_to_globe' && (result?.ok !== true || result.cancelled))
    return 'The Globe View reset did not finish. No further actions were run for this request.';
  if (name !== 'move_camera' || args?.motion !== 'rotate_globe') return null;
  if (result?.ok === true && !result.cancelled) return null;
  if (result?.reason === 'globe-reset-unavailable')
    return 'The requested globe rotation did not start. Zoom out further; the Globe View preset does not fit this viewport. No further actions were run for this request.';
  if (result?.reason === 'globe-view-required')
    return 'Globe rotation isn’t available from this view. You can type “Reset to Globe View and rotate the globe.” No further actions were run for this request.';
  return 'The requested globe rotation did not start. Check the camera tool result. No further actions were run for this request.';
}

// Panel operations can be unavailable or lose ownership during a Cockpit exit.
// Keep refusals local, just like camera refusals, so another model round cannot
// turn them into a success claim or retry after a newer manual choice.
function isPanelCommand(name, args) {
  return (
    name === 'set_panel_open' ||
    name === 'set_voice_inactivity_timeout' ||
    (name === 'control_cockpit' && Boolean(args?.voicePanel))
  );
}
function panelRefusalReply(name, args, result) {
  if (!isPanelCommand(name, args) || (result?.ok === true && !result.cancelled))
    return null;
  if (
    name === 'set_panel_open' &&
    (args?.panelId || args?.panel) === 'settings'
  )
    return 'Voice settings or Provider settings?';
  const prefix = result?.cockpitExited ? 'Cockpit exited. ' : '';
  return (
    prefix +
    (name === 'set_voice_inactivity_timeout'
      ? 'Voice inactivity was not changed. The control is unavailable or the requested value is invalid; use a whole number from 0 to 60 minutes.'
      : 'The requested panel was not changed. Its controls are unavailable in this view, or a newer choice cancelled the operation.')
  );
}

/**
 * Result recorded for a call that cancellation reached before it started.
 *
 * Abandoning the call silently is not an option: a provider answers an
 * assistant `tool_calls` entry whose results are incomplete with a 400, so a
 * cancelled round still has to answer the calls it never dispatched.
 */
function cancelledActionResult(name) {
  return {
    ok: false,
    action: name,
    error: 'Command cancelled before this action ran.',
  };
}

/**
 * Create a stateful agent session.
 *
 * @param {{
 *   runAction: (name: string, args: object) => Promise<object>,
 *   fetchImpl?: typeof fetch,
 *   endpoint?: string,
 *   maxToolRounds?: number,
 *   maxRequestBytes?: number,
 * }} options
 */
function createAgentSession({
  runAction,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  endpoint = AGENT_COMMAND_ENDPOINT,
  maxToolRounds = MAX_TOOL_ROUNDS,
  maxRequestBytes = MAX_REQUEST_HISTORY_BYTES,
}) {
  if (typeof runAction !== 'function') {
    throw new TypeError('createAgentSession requires a runAction function');
  }

  let messages = [];
  let usage = emptyUsage();
  let inFlight = null;

  /** POST one turn, trimming the transcript to fit the request body first. */
  async function postTurn({ provider, model, binding, signal, onEvent }) {
    const fitted = fitHistoryToBytes(messages, { maxBytes: maxRequestBytes });
    if (fitted.dropped) {
      // The console keeps showing the whole exchange; only what the model is
      // reminded of shrinks, so say so rather than letting it forget silently.
      messages = fitted.messages;
      onEvent({
        type: AGENT_EVENTS.WARNING,
        warning: {
          code: 'history-trimmed',
          message: `Dropped ${fitted.dropped} older messages to fit the request budget.`,
        },
      });
    }
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        messages,
        ...(binding ? { binding } : {}),
      }),
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(
        data?.error || `Agent request failed (HTTP ${response.status})`,
      );
    }
    // A 2xx body is still not a turn unless it carries a message. Pushing a
    // missing one into the transcript reports the command as an empty success
    // and breaks every later command on the orphan it leaves behind.
    if (!data.message || typeof data.message !== 'object') {
      throw new Error(data.error || 'Agent response carried no message');
    }
    return data;
  }

  return {
    /** The transcript, for rendering. Callers must not mutate it. */
    get transcript() {
      return messages;
    },

    /** Cumulative token usage for this session. */
    get usage() {
      return { ...usage };
    },

    /** Whether a command is currently running. */
    get busy() {
      return inFlight !== null;
    },

    /** Discard the transcript and usage, e.g. when the provider changes. */
    reset() {
      messages = [];
      usage = emptyUsage();
    },

    /** Abort the running command, if any. */
    abort() {
      inFlight?.abort();
    },

    /**
     * Send one typed command and run it to completion.
     *
     * @param {string} text
     * @param {{provider?: string, model?: string,
     *   onEvent?: (event: object) => void}} [options]
     * @returns {Promise<{ok: boolean, content: string, rounds: number, error?: string}>}
     */
    async send(text, { provider, model, binding, onEvent = () => {} } = {}) {
      const command = typeof text === 'string' ? text.trim() : '';
      if (!command)
        return { ok: false, content: '', rounds: 0, error: 'Empty command' };
      if (inFlight) {
        return {
          ok: false,
          content: '',
          rounds: 0,
          error: 'A command is already running',
        };
      }

      const controller = new AbortController();
      inFlight = controller;
      messages.push({ role: 'user', content: command });
      onEvent({
        type: AGENT_EVENTS.MESSAGE,
        message: { role: 'user', content: command },
      });

      try {
        for (let round = 0; round < maxToolRounds; round += 1) {
          controller.signal.throwIfAborted();
          onEvent({ type: AGENT_EVENTS.REQUEST, round });

          const data = await postTurn({
            provider,
            model,
            binding,
            signal: controller.signal,
            onEvent,
          });
          usage = addUsage(usage, data.usage);
          const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
          if (!toolCalls.length) controller.signal.throwIfAborted();
          const guardedCalls = toolCalls.some(
            (call) =>
              ['move_camera', 'zoom_to_globe'].includes(call.name) ||
              isPanelCommand(call.name, call.args),
          );
          // Narration before execution may claim an action that is refused.
          messages.push(
            guardedCalls ? { ...data.message, content: '' } : data.message,
          );
          for (const warning of Array.isArray(data.warnings)
            ? data.warnings
            : []) {
            onEvent({ type: AGENT_EVENTS.WARNING, warning });
          }

          if (!toolCalls.length) {
            const content = data.message?.content || '';
            onEvent({
              type: AGENT_EVENTS.MESSAGE,
              message: { role: 'assistant', content },
            });
            onEvent({ type: AGENT_EVENTS.DONE, rounds: round + 1 });
            return { ok: !data.toolCallFailed, content, rounds: round + 1 };
          }

          // The model may narrate alongside a call; surface it so the console
          // is not silent while several tools run.
          if (
            data.message?.content &&
            !guardedCalls &&
            !controller.signal.aborted
          ) {
            onEvent({
              type: AGENT_EVENTS.MESSAGE,
              message: { role: 'assistant', content: data.message.content },
            });
          }

          let refusalReply = null;
          for (const [index, call] of toolCalls.entries()) {
            // Checked at the top of every iteration, so this covers both the
            // first dispatch and the gap after each action's await: an abort
            // that lands while one tool runs must not start the next one.
            if (controller.signal.aborted) {
              for (const unrun of toolCalls.slice(index)) {
                const cancelled = cancelledActionResult(unrun.name);
                onEvent({
                  type: AGENT_EVENTS.TOOL_START,
                  name: unrun.name,
                  args: unrun.args,
                });
                onEvent({
                  type: AGENT_EVENTS.TOOL_RESULT,
                  name: unrun.name,
                  result: cancelled,
                });
                messages.push(toolResultMessage(unrun.id, cancelled));
              }
              controller.signal.throwIfAborted();
            }
            onEvent({
              type: AGENT_EVENTS.TOOL_START,
              name: call.name,
              args: call.args,
            });
            const result = refusalReply
              ? {
                  ok: false,
                  action: call.name,
                  skipped: true,
                  error:
                    'Not run: a camera or panel request was refused or cancelled.',
                }
              : await runActionSafely(
                  runAction,
                  call.name,
                  call.args,
                  controller.signal,
                );
            refusalReply ||=
              cameraRefusalReply(call.name, call.args, result) ||
              panelRefusalReply(call.name, call.args, result);
            onEvent({
              type: AGENT_EVENTS.TOOL_RESULT,
              name: call.name,
              result,
            });
            messages.push(toolResultMessage(call.id, result));
          }
          controller.signal.throwIfAborted();
          if (refusalReply) {
            const message = { role: 'assistant', content: refusalReply };
            messages.push(message);
            onEvent({ type: AGENT_EVENTS.MESSAGE, message });
            onEvent({ type: AGENT_EVENTS.DONE, rounds: round + 1 });
            return { ok: false, content: refusalReply, rounds: round + 1 };
          }
        }

        const error = `Stopped after ${maxToolRounds} tool rounds without a final answer.`;
        onEvent({ type: AGENT_EVENTS.ERROR, error });
        return { ok: false, content: '', rounds: maxToolRounds, error };
      } catch (error) {
        const message =
          error?.name === 'AbortError'
            ? 'Command cancelled.'
            : error?.message || 'Agent request failed';
        onEvent({ type: AGENT_EVENTS.ERROR, error: message });
        return { ok: false, content: '', rounds: 0, error: message };
      } finally {
        inFlight = null;
      }
    },
  };
}

export {
  AGENT_COMMAND_ENDPOINT,
  AGENT_EVENTS,
  MAX_REQUEST_HISTORY_BYTES,
  MAX_TOOL_ROUNDS,
  createAgentSession,
  emptyUsage,
};
