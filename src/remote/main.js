import { parseLocalFrame } from '../voice/localVoiceProtocol.js';
import { createVadCapture } from '../voice/localSpeechCapture.js';
import {
  QUICK_ACTIONS,
  REMOTE_STATUS,
  createRemoteState,
  micSupported,
  reconnectDelay,
  reduceHubMessage,
  remoteSocketUrl,
} from './remoteFeed.js';

/**
 * Companion page for the local voice assistant. Connects to the remote hub
 * (/api/voice/remote), mirrors the globe's transcript and sends typed or
 * spoken commands. Replies are spoken on the globe machine, never here.
 */
const byId = (id) => document.getElementById(id);
const feed = byId('remote-feed');
const pill = byId('remote-status');
const form = byId('remote-form');
const input = byId('remote-input');
const sendButton = byId('remote-send');
const interruptButton = byId('remote-interrupt');
const micButton = byId('remote-mic');
const micHint = byId('remote-mic-hint');
const chips = byId('remote-chips');
const MAX_LINES = 200;
const TAGS = { assistant: 'GEV', tool: 'RUN', system: 'SYS', error: 'ERR' };

byId('remote-host').textContent = location.host;

let socket = null;
let attempt = 0;
let timer = null;
let wasConnected = false;
const state = createRemoteState();

function setPill(status) {
  pill.textContent = status.label;
  pill.dataset.tone = status.tone;
}

function setConnected(connected) {
  input.disabled = !connected;
  sendButton.disabled = !connected;
  interruptButton.disabled = !connected;
  for (const chip of chips.querySelectorAll('button'))
    chip.disabled = !connected;
}

/** Feed label: typed on a remote, spoken into a mic, or a fixed role tag. */
function tagFor(role, source) {
  if (role !== 'user') return TAGS[role];
  return source === 'remote' ? 'YOU' : 'MIC';
}

function addLine(role, text, { source } = {}) {
  const item = document.createElement('li');
  item.className = `line line--${role}`;
  const tag = document.createElement('span');
  tag.className = 'line-tag';
  tag.textContent = tagFor(role, source);
  const body = document.createElement('span');
  body.className = 'line-text';
  body.textContent = text;
  item.append(tag, body);
  feed.append(item);
  while (feed.children.length > MAX_LINES) feed.firstElementChild.remove();
  feed.scrollTop = feed.scrollHeight;
}

function isOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

function sendJson(frame) {
  if (!isOpen()) {
    addLine('error', 'Not connected to the globe yet');
    return false;
  }
  socket.send(JSON.stringify(frame));
  return true;
}

function sendBinary(bytes) {
  if (!isOpen()) return false;
  socket.send(bytes);
  return true;
}

function onMessage(data) {
  const parsed = parseLocalFrame(data);
  if (!parsed || parsed.kind !== 'json') return;
  const { lines, status } = reduceHubMessage(state, parsed.frame);
  for (const entry of lines) addLine(entry.role, entry.text, entry);
  if (status) setPill(status);
}

function scheduleReconnect() {
  clearTimeout(timer);
  timer = setTimeout(connect, reconnectDelay(attempt++));
}

function connect() {
  clearTimeout(timer);
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN)
  )
    return;
  setPill(REMOTE_STATUS.connecting);
  const ws = new WebSocket(remoteSocketUrl(location));
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    attempt = 0;
    wasConnected = true;
    setConnected(true);
  });
  ws.addEventListener('message', (event) => {
    if (socket === ws) onMessage(event.data);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    setConnected(false);
    setPill(REMOTE_STATUS.offline);
    if (wasConnected) {
      wasConnected = false;
      addLine('system', `Lost the link to ${location.host}; retrying`);
    }
    scheduleReconnect();
  });
  ws.addEventListener('error', () => ws.close());
}

for (const text of QUICK_ACTIONS) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'remote-chip';
  chip.textContent = text;
  chip.disabled = true;
  chip.addEventListener('click', () => sendJson({ type: 'text', text }));
  chips.append(chip);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  if (sendJson({ type: 'text', text })) input.value = '';
});

interruptButton.addEventListener('click', () =>
  sendJson({ type: 'interrupt' }),
);

// Microphone: only in secure contexts. Over plain http from a phone the
// browser hides getUserMedia entirely, so the page says so and stays text-only.
let mic = null;
if (
  micSupported({
    mediaDevices: navigator.mediaDevices,
    isSecureContext: window.isSecureContext,
  })
) {
  micButton.hidden = false;
  micButton.addEventListener('click', toggleMic);
} else {
  micHint.hidden = false;
}

function stopMic() {
  const current = mic;
  mic = null;
  current?.capture.destroy();
  current?.stream.getTracks().forEach((track) => track.stop());
  micButton.dataset.state = 'off';
  micButton.textContent = 'MIC';
}

async function toggleMic() {
  if (mic) {
    stopMic();
    addLine('system', 'Phone mic off');
    return;
  }
  micButton.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const capture = createVadCapture({
      onSpeechStart: () => {
        if (mic) micButton.dataset.state = 'hearing';
      },
      onSpeechEnd: () => {
        if (mic) micButton.dataset.state = 'on';
      },
      onUtterance: (bytes) => {
        if (!mic || !bytes?.byteLength) return;
        if (sendBinary(bytes)) sendJson({ type: 'audio_end' });
      },
    });
    mic = { stream, capture };
    await capture.start(stream);
    if (!mic) return;
    micButton.dataset.state = 'on';
    micButton.textContent = 'MIC ON';
    addLine('system', 'Phone mic live; speak a command');
  } catch (error) {
    stopMic();
    addLine('error', error?.message || 'Microphone unavailable');
  } finally {
    micButton.disabled = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || socket) return;
  attempt = 0;
  connect();
});
window.addEventListener('pagehide', stopMic);

connect();
