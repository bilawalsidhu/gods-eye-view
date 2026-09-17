/**
 * Pure helpers for the local voice wire protocol. The server sends JSON text
 * frames plus binary audio; these functions map them to common session events
 * and mic-panel status without touching the DOM or the socket.
 */
export const LOCAL_VOICE_STATUS = Object.freeze({
  listening: 'Ask or command',
  hearing: 'Hearing you',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  running: 'Running command',
  speaking: 'Speaking',
  nothingHeard: 'Nothing heard, try again',
});

/** Classify one WebSocket message as binary audio or a parsed JSON frame. */
export function parseLocalFrame(data) {
  if (data == null) return null;
  if (data instanceof ArrayBuffer) return { kind: 'binary', bytes: data };
  if (ArrayBuffer.isView(data))
    return {
      kind: 'binary',
      bytes: data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ),
    };
  if (typeof data !== 'string') return null;
  try {
    const frame = JSON.parse(data);
    if (!frame || typeof frame.type !== 'string') return null;
    return { kind: 'json', frame };
  } catch {
    return null;
  }
}

/** Translate a server frame into the protocol-independent session events. */
export function localSessionEvents(frame) {
  if (!frame) return [];
  if (frame.type === 'transcript') {
    const text = String(frame.text || '').trim();
    return text
      ? [{ type: 'transcript', role: 'user', text, final: true }]
      : [];
  }
  if (frame.type === 'text') {
    const text = String(frame.text || '').trim();
    const events = [];
    if (text)
      events.push({ type: 'transcript', role: 'assistant', text, final: true });
    events.push({ type: 'completion', status: 'completed' });
    return events;
  }
  return [];
}

/** Which mic-panel state and caption a frame implies, or null to leave it. */
export function statusForFrame(frame) {
  if (!frame) return null;
  switch (frame.type) {
    case 'transcript': {
      const text = String(frame.text || '').trim();
      if (!text || frame.noSpeech)
        return { state: 'listening', detail: LOCAL_VOICE_STATUS.nothingHeard };
      // The server tags the transcript with an enrolled speaker when it
      // recognises the voice (docs/SPEAKER-ID.md).
      const who = frame.speaker?.name ? ` (${frame.speaker.name})` : '';
      return {
        state: 'executing',
        detail: `HEARD${who}: ${compact(text, 60)}`,
      };
    }
    case 'thinking':
      return { state: 'executing', detail: LOCAL_VOICE_STATUS.thinking };
    case 'tool_call':
      return { state: 'executing', detail: LOCAL_VOICE_STATUS.running };
    case 'text':
      return { state: 'listening', detail: LOCAL_VOICE_STATUS.listening };
    case 'error':
      return {
        state: frame.terminal === false ? 'listening' : 'error',
        detail: String(frame.error || 'Local voice unavailable'),
      };
    default:
      return null;
  }
}

/** Does this error frame end the session, or can the mic keep listening? */
export function isTerminalErrorFrame(frame) {
  return frame?.type === 'error' && frame.terminal !== false;
}

function compact(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
