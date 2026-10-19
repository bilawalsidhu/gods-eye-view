import {
  localCommandPlan,
  localActionReply,
  runLocalAction,
  selectedTrackingArguments,
} from './localCommands.js';
import { LOCAL_ACTION_TOOLS, localToolGroup } from './localPrompt.js';
import {
  localNavigationArguments,
  localNavigationReply,
} from './localNavigation.js';

const actions = new Set(LOCAL_ACTION_TOOLS.map((tool) => tool.function.name));

export async function localJson(path, body, signal, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/local-ai/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: 'no-store',
    redirect: 'error',
  });
  const data = await response.json();
  signal?.throwIfAborted();
  if (!response.ok)
    throw new Error(data.error || `Local AI: HTTP ${response.status}`);
  return data;
}

/** Keep complete user turns together so tool results never lose their calls. */
export function trimLocalHistory(messages, maxChars = 8000) {
  const history = [...messages];
  while (
    history.length > 1 &&
    (JSON.stringify(history).length > maxChars || history.length > 32)
  ) {
    const nextTurn = history.findIndex(
      (message, index) => index > 0 && message.role === 'user',
    );
    if (nextTurn < 0) break;
    history.splice(0, nextTurn);
  }
  return history;
}

export async function runLocalTurn({
  text,
  history = [],
  runAction,
  signal,
  request = localJson,
  emit = () => {},
  language = /[а-яё]/iu.test(text) ? 'ru' : 'en',
}) {
  const messages = trimLocalHistory([
    ...history,
    { role: 'user', content: text.slice(0, 4000) },
  ]);
  signal?.throwIfAborted();
  emit({ type: 'transcript', role: 'user', text, final: true });
  const finish = (reply) => {
    messages.push({ role: 'assistant', content: reply });
    emit({ type: 'transcript', role: 'assistant', text: reply, final: true });
    return { text: reply, history: trimLocalHistory(messages) };
  };
  const plan = localCommandPlan(text);
  if (plan) {
    const replies = [];
    let previous;
    for (const [index, command] of plan.entries()) {
      signal?.throwIfAborted();
      let args = command.args || {},
        result;
      try {
        if (command.selected) args = selectedTrackingArguments(previous);
        result = await runLocalAction(command.name, args, runAction, signal);
      } catch (error) {
        signal?.throwIfAborted();
        result = { ok: false, error: error.message };
      }
      signal?.throwIfAborted();
      const id = 'local-command-' + index;
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: command.name, arguments: JSON.stringify(args) },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify(result ?? null),
      });
      if (command.name !== 'get_entity_context' || result?.ok !== true)
        replies.push(localActionReply(command.name, args, result, language));
      previous = result;
      if (
        result?.ok !== true ||
        (command.name === 'fly_to_location' && result.arrived !== true)
      )
        break;
    }
    return finish(replies.join(' '));
  }
  const navigations = new Map();
  const singleAction = !/(?:^|\s)(?:и|затем|потом|and|then)(?:\s|$)|;/iu.test(
    text,
  );
  const confirmations = new Set([
    'fly_to_location',
    'adjust_camera_zoom',
    'zoom_to_globe',
    'track_entity',
    'select_nearest_aircraft',
    'stop_tracking',
  ]);
  let lastNavigation, lastFailure;
  for (let round = 0; round < 6; round++) {
    const { message } = await request('chat', { messages }, signal);
    signal?.throwIfAborted();
    if (
      !message ||
      (message.content != null && typeof message.content !== 'string')
    )
      throw new Error('Invalid local model response');
    const calls = message.tool_calls || [];
    if (!Array.isArray(calls) || calls.length > 4)
      throw new Error('Too many local tool calls');
    if (!calls.length) {
      const reply = (message.content || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
      if (!reply) throw new Error('Local model returned an empty answer');
      return finish(
        lastNavigation &&
          (lastNavigation.ok !== true || lastNavigation.arrived !== true)
          ? localNavigationReply(lastNavigation, language)
          : lastFailure
            ? localActionReply(
                lastFailure.name,
                lastFailure.args,
                lastFailure.result,
                language,
              )
            : reply,
      );
    }
    const ids = new Set();
    for (const call of calls) {
      if (
        typeof call.id !== 'string' ||
        !call.id ||
        ids.has(call.id) ||
        call.type !== 'function'
      )
        throw new Error('Invalid local tool call');
      ids.add(call.id);
    }
    messages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: calls,
    });
    for (const call of calls) {
      signal?.throwIfAborted();
      const name = call.function?.name;
      let result, args;
      try {
        args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Error('Tool arguments must be an object');
        if (name === 'get_map_tools') result = localToolGroup(args.group);
        else if (name === 'web_search')
          result = await request('search', args, signal);
        else if (name === 'fly_to_location') {
          const navigationArgs = localNavigationArguments(args, text);
          const key = navigationArgs.query.toLowerCase();
          if (navigations.has(key)) result = navigations.get(key);
          else {
            result = await runAction(name, navigationArgs, { signal });
            navigations.set(key, result ?? { ok: false });
          }
        } else if (actions.has(name))
          result = await runLocalAction(name, args, runAction, signal);
        else throw new Error('Unknown map action');
      } catch (error) {
        signal?.throwIfAborted();
        result = { error: error.message };
      }
      signal?.throwIfAborted();
      if (result?.error || result?.ok === false || result?.cancelled)
        lastFailure = { name, args: args || {}, result };
      if (name === 'fly_to_location') lastNavigation = result ?? { ok: false };
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result ?? null).slice(0, 4000),
      });
      // These commands have an authoritative application result. A second
      // generation just to narrate it adds latency and can invent success.
      if (singleAction && calls.length === 1 && confirmations.has(name))
        return finish(localActionReply(name, args || {}, result, language));
    }
  }
  throw new Error(
    'Local model reached the action limit; try a simpler command',
  );
}
