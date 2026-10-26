import { tn, t } from '../i18n/index.js';
import { createPeerChat, normalizeChatName } from './peerChat.js';

const STORAGE_KEYS = Object.freeze({
  minimized: 'gev.chat.minimized',
  nickname: 'gev.chat.nickname',
  server: 'gev.chat.server',
});
const MAX_VISIBLE_MESSAGES = 100;
const MENTION_PATTERN = /@([\p{L}\p{N}_.-]+)/gu;

function readStored(storage, key, fallback) {
  try {
    return storage?.getItem(key) ?? fallback;
  } catch (error) {
    console.warn(`[Chat] Could not read ${key}: ${error.message}`);
    return fallback;
  }
}

function writeStored(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch (error) {
    console.warn(`[Chat] Could not save ${key}: ${error.message}`);
  }
}

function appendMentionText(documentRef, parent, text, names) {
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    const start = match.index;
    if (
      start === undefined ||
      !names.has(name.toLocaleLowerCase()) ||
      start < cursor
    ) {
      continue;
    }
    parent.append(documentRef.createTextNode(text.slice(cursor, start)));
    const mention = documentRef.createElement('mark');
    mention.textContent = match[0];
    parent.append(mention);
    cursor = start + match[0].length;
  }
  parent.append(documentRef.createTextNode(text.slice(cursor)));
}

function renderMessage(documentRef, list, message, names) {
  const item = documentRef.createElement('li');
  item.className = 'global-chat-message';
  const meta = documentRef.createElement('div');
  meta.className = 'global-chat-message-meta';
  const name = documentRef.createElement('span');
  name.className = 'global-chat-message-name';
  name.textContent = message.name;
  if (message.local) name.classList.add('is-local');
  const time = documentRef.createElement('time');
  const date = new Date(message.timestamp);
  time.dateTime = date.toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  meta.append(name, time);
  const text = documentRef.createElement('div');
  text.className = 'global-chat-message-text';
  appendMentionText(documentRef, text, message.text, names);
  item.append(meta, text);
  list.append(item);
  while (list.children.length > MAX_VISIBLE_MESSAGES)
    list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}

function statusText(status) {
  if (status === 'connecting') return t('Connecting...');
  if (status === 'connected') return t('Connected');
  return t('Disconnected');
}

/**
 * Mount the minimizable global chat panel. Nicknames and server URLs are local
 * browser preferences, not accounts or verified identities.
 */
export function initGlobalChatPanel({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storage,
  chat = createPeerChat(),
} = {}) {
  const root = documentRef?.getElementById('global-chat');
  if (!root) return () => {};
  const cornerActions = documentRef.getElementById('corner-actions');
  if (!cornerActions)
    throw new Error('Global chat is missing its corner actions container.');
  cornerActions.prepend(root);
  let storageRef = storage;
  if (!storageRef) {
    try {
      storageRef = windowRef?.localStorage;
    } catch (error) {
      console.warn(`[Chat] Browser storage is unavailable: ${error.message}`);
    }
  }

  const elements = {
    count: documentRef.getElementById('global-chat-count'),
    connect: documentRef.getElementById('global-chat-connect'),
    connectForm: documentRef.getElementById('global-chat-connect-form'),
    disconnect: documentRef.getElementById('global-chat-disconnect'),
    error: documentRef.getElementById('global-chat-error'),
    message: documentRef.getElementById('global-chat-message'),
    messages: documentRef.getElementById('global-chat-messages'),
    minimize: documentRef.getElementById('global-chat-minimize'),
    mentionList: documentRef.getElementById('global-chat-mentions'),
    messageForm: documentRef.getElementById('global-chat-send-form'),
    nickname: documentRef.getElementById('global-chat-nickname'),
    panel: documentRef.getElementById('global-chat-panel'),
    presence: documentRef.getElementById('global-chat-presence'),
    server: documentRef.getElementById('global-chat-server'),
    toggle: documentRef.getElementById('global-chat-toggle'),
  };
  for (const [name, element] of Object.entries(elements)) {
    if (!element)
      throw new Error(`Global chat is missing its ${name} element.`);
  }

  elements.nickname.value = readStored(storageRef, STORAGE_KEYS.nickname, '');
  elements.server.value = readStored(storageRef, STORAGE_KEYS.server, '');
  const minimized =
    readStored(storageRef, STORAGE_KEYS.minimized, 'true') !== 'false';
  const participantNames = new Set();
  const updateMinimized = (value) => {
    root.classList.toggle('is-minimized', value);
    elements.panel.hidden = value;
    elements.toggle.setAttribute('aria-expanded', String(!value));
    elements.toggle.setAttribute(
      'aria-label',
      value ? t('Open global chat') : t('Global chat'),
    );
    writeStored(storageRef, STORAGE_KEYS.minimized, String(value));
  };
  const showError = (message) => {
    elements.error.textContent = message || '';
    elements.error.hidden = !message;
  };
  const onToggle = () => updateMinimized(false);
  const onMinimize = () => updateMinimized(true);
  const onConnect = (event) => {
    event.preventDefault();
    showError('');
    const nickname = normalizeChatName(elements.nickname.value);
    if (!nickname) {
      showError(
        t('Choose a valid nickname: 2–24 letters, numbers, _, . or -.'),
      );
      elements.nickname.focus();
      return;
    }
    const server = elements.server.value.trim();
    writeStored(storageRef, STORAGE_KEYS.nickname, nickname);
    writeStored(storageRef, STORAGE_KEYS.server, server);
    try {
      chat.connect({ url: server, nickname });
    } catch (error) {
      showError(error.message);
    }
  };
  const onDisconnect = () => {
    showError('');
    chat.disconnect();
  };
  const onSend = (event) => {
    event.preventDefault();
    showError('');
    try {
      if (chat.send(elements.message.value)) elements.message.value = '';
    } catch (error) {
      showError(error.message);
    }
  };
  const onStatus = (status) => {
    elements.presence.textContent = statusText(status);
    const connected = status === 'connected';
    root.classList.toggle('is-connected', connected);
    elements.server.disabled = connected || status === 'connecting';
    elements.nickname.disabled = connected || status === 'connecting';
    elements.connect.disabled = connected || status === 'connecting';
    elements.disconnect.hidden = !connected && status !== 'connecting';
    elements.connect.hidden = connected;
    elements.messageForm.hidden = !connected;
    elements.message.disabled = !connected;
    elements.messageForm.querySelector('button[type="submit"]').disabled =
      !connected;
  };
  const onParticipants = (participants) => {
    const names = Array.isArray(participants) ? participants : [];
    participantNames.clear();
    elements.mentionList.replaceChildren();
    for (const participant of names) {
      if (typeof participant.name !== 'string') continue;
      participantNames.add(participant.name.toLocaleLowerCase());
      if (!participant.local) {
        const option = documentRef.createElement('option');
        option.value = `@${participant.name}`;
        elements.mentionList.append(option);
      }
    }
    elements.count.textContent = String(names.length);
    elements.count.setAttribute(
      'aria-label',
      tn(names.length, '{count} participant', '{count} participants'),
    );
  };
  const onMessage = (message) => {
    renderMessage(documentRef, elements.messages, message, participantNames);
  };
  const onError = (message) => showError(message);
  const onBeforeUnload = () => chat.disconnect();
  const unsubscribers = [
    chat.on('status', onStatus),
    chat.on('participants', onParticipants),
    chat.on('message', onMessage),
    chat.on('error', onError),
  ];

  elements.toggle.addEventListener('click', onToggle);
  elements.minimize.addEventListener('click', onMinimize);
  elements.connectForm.addEventListener('submit', onConnect);
  elements.disconnect.addEventListener('click', onDisconnect);
  elements.messageForm.addEventListener('submit', onSend);
  windowRef?.addEventListener('beforeunload', onBeforeUnload);
  updateMinimized(minimized);
  onStatus('disconnected');
  onParticipants([]);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    elements.toggle.removeEventListener('click', onToggle);
    elements.minimize.removeEventListener('click', onMinimize);
    elements.connectForm.removeEventListener('submit', onConnect);
    elements.disconnect.removeEventListener('click', onDisconnect);
    elements.messageForm.removeEventListener('submit', onSend);
    windowRef?.removeEventListener('beforeunload', onBeforeUnload);
    for (const unsubscribe of unsubscribers) unsubscribe();
    chat.dispose();
  };
}
