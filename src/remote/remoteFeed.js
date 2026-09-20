import { localSessionEvents } from '../voice/localVoiceProtocol.js';

/**
 * Pure helpers for the companion page (remote.html). The hub wraps voice
 * frames as {type:'session', sessionId, frame}; these functions turn hub
 * messages into transcript lines and a status pill without touching the DOM
 * or the socket.
 */
export const REMOTE_WS_PATH = '/api/voice/remote';

export const QUICK_ACTIONS = Object.freeze([
  'Zoom out to the globe',
  'Show live flights',
  'Track the nearest aircraft',
  'Stop tracking',
  'Thermal view',
  'Normal view',
  'Fly to Tokyo',
  'What am I looking at',
]);

export const REMOTE_STATUS = Object.freeze({
  connecting: Object.freeze({ label: 'CONNECTING', tone: 'idle' }),
  offline: Object.freeze({ label: 'OFFLINE', tone: 'error' }),
  noSession: Object.freeze({ label: 'NO SESSION', tone: 'idle' }),
  active: Object.freeze({ label: 'SESSION ACTIVE', tone: 'active' }),
  thinking: Object.freeze({ label: 'THINKING', tone: 'busy' }),
  running: Object.freeze({ label: 'RUNNING', tone: 'busy' }),
  nothingHeard: Object.freeze({ label: 'NOTHING HEARD', tone: 'active' }),
});

/** Same-origin socket URL; ws: over http, wss: over https. */
export function remoteSocketUrl(location, path = REMOTE_WS_PATH) {
  if (/^wss?:/i.test(path)) return path;
  const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location?.host || 'localhost:4173'}${path}`;
}

/** Exponential backoff capped at max; attempt 0 is the first retry. */
export function reconnectDelay(attempt, { base = 1000, max = 15000 } = {}) {
  const step = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(max, base * 2 ** step);
}

/** getUserMedia only exists in secure contexts (https or localhost). */
export function micSupported({ mediaDevices, isSecureContext } = {}) {
  return (
    typeof mediaDevices?.getUserMedia === 'function' && isSecureContext === true
  );
}

export function createRemoteState() {
  return { active: [], announced: false };
}

/** One line of the transcript feed. */
function line(role, text, extra = {}) {
  return { role, text, ...extra };
}

/** Compact "name key=value" summary of a tool_call frame. */
export function describeToolCall(frame) {
  const name = String(frame?.name || 'tool');
  const args =
    frame?.arguments && typeof frame.arguments === 'object'
      ? frame.arguments
      : {};
  const parts = Object.entries(args).map(
    ([key, value]) =>
      `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  const text = parts.length ? `${name} ${parts.join(' ')}` : name;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Reduce one hub message into feed lines and a status hint.
 * Mutates state (active session ids) and returns { lines, status }.
 */
export function reduceHubMessage(state, message) {
  const lines = [];
  let status = null;
  if (!message || typeof message.type !== 'string') return { lines, status };
  if (message.type === 'sessions') {
    const next = Array.isArray(message.active)
      ? message.active.map(String)
      : [];
    const had = state.active.length > 0;
    const has = next.length > 0;
    if (state.announced && had !== has)
      lines.push(
        line(
          'system',
          has ? 'Globe voice session started' : 'Globe voice session ended',
        ),
      );
    state.active = next;
    state.announced = true;
    status = has ? REMOTE_STATUS.active : REMOTE_STATUS.noSession;
    return { lines, status };
  }
  if (message.type === 'error') {
    lines.push(line('error', String(message.error || 'Remote command failed')));
    return { lines, status };
  }
  if (message.type !== 'session') return { lines, status };
  const frame = message.frame;
  if (!frame || typeof frame.type !== 'string') return { lines, status };
  for (const event of localSessionEvents(frame)) {
    if (event.type !== 'transcript') continue;
    lines.push(
      line(event.role, event.text, {
        source: frame.source === 'remote' ? 'remote' : 'globe',
      }),
    );
  }
  switch (frame.type) {
    case 'ready':
      lines.push(
        line(
          'system',
          `Globe voice ready${frame.model ? ` · ${frame.model}` : ''}`,
        ),
      );
      status = REMOTE_STATUS.active;
      break;
    case 'transcript':
      status = String(frame.text || '').trim()
        ? REMOTE_STATUS.thinking
        : REMOTE_STATUS.nothingHeard;
      break;
    case 'thinking':
      status = REMOTE_STATUS.thinking;
      break;
    case 'tool_call':
      lines.push(line('tool', describeToolCall(frame)));
      status = REMOTE_STATUS.running;
      break;
    case 'text':
    case 'audio_end':
      status = REMOTE_STATUS.active;
      break;
    case 'error':
      lines.push(line('error', String(frame.error || 'Local voice error')));
      status =
        frame.terminal === false
          ? REMOTE_STATUS.active
          : REMOTE_STATUS.noSession;
      break;
    default:
      break;
  }
  return { lines, status };
}
