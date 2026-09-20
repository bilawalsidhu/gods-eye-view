import { randomUUID } from 'node:crypto';

/**
 * Session-level extras for the local voice path: the browser's cross-session
 * memory folded into the system prompt, and unprompted spoken alerts.
 */
export const LOCAL_TOOL_HINT =
  'Local-only tools are available: remember_place / go_to_saved_place / ' +
  'list_saved_places / forget_place, recall_recent_target for earlier targets, ' +
  'ask_about_view for visual questions about the screen, data_report for grouped ' +
  'data questions, watch_add / watch_list / watch_clear for standing alerts, ' +
  'rewind_time / resume_live for position replay, and enroll_voice / ' +
  'who_is_speaking / list_voices / forget_voice for recognising who is talking.';

export const SPOKEN_STYLE =
  'STYLE: replies are spoken aloud. Use plain sentences, no markdown, no bullet ' +
  'lists, no IDs or field names unless asked. Keep it under 30 words unless the ' +
  'user asks for detail. When the user names something ("remember this as home") ' +
  'use that name directly without asking. Report airlines, operators and names exactly as tool results give them; never guess an airline from a callsign, and only mention items that actually appear in tool results.';

/** Insert or replace the MEMORY system message from a browser context frame. */
export function applyMemoryContext(session, event) {
  const places = Array.isArray(event?.memory?.places)
    ? event.memory.places
    : [];
  const recent = Array.isArray(event?.memory?.recent)
    ? event.memory.recent
    : [];
  const watches = Number(event?.watches) || 0;
  const lines = [];
  if (places.length)
    lines.push(`Saved places (go_to_saved_place): ${places.join(', ')}.`);
  if (recent.length)
    lines.push(`Recent targets (recall_recent_target): ${recent.join('; ')}.`);
  if (watches) lines.push(`${watches} standing alert(s) active (watch_list).`);
  lines.push(LOCAL_TOOL_HINT);
  lines.push(SPOKEN_STYLE);
  const content = ['MEMORY', ...lines].join('\n');
  const index = session.messages.findIndex(
    (message) =>
      message.role === 'system' && String(message.content).startsWith('MEMORY'),
  );
  if (index >= 0) session.messages[index] = { role: 'system', content };
  else session.messages.splice(1, 0, { role: 'system', content });
  return content;
}

/**
 * Speak an unprompted alert and keep it in the conversation history. `origin`
 * names the peer globe an alert came from (peers.js) so hubs never forward it
 * a second time.
 */
export async function speakNotice(
  session,
  text,
  {
    send,
    worker,
    log = () => {},
    createSpeechQueue,
    origin = null,
    kind = null,
  },
) {
  const turnId = randomUUID();
  const speech = createSpeechQueue({
    session,
    turnId,
    worker,
    send,
    signal: session.closeSignal,
    log,
  });
  log('notice', { turnId, text });
  session.messages.push({
    role: 'assistant',
    content: `(${kind === 'info' ? 'Notice' : 'Alert'}) ${text}`,
  });
  send({
    type: 'notice',
    turnId,
    text,
    ...(origin ? { origin } : {}),
    ...(kind ? { kind } : {}),
  });
  speech.enqueue(text);
  await speech.finish();
}
