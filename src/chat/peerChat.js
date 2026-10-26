import { msg, t } from '../i18n/index.js';

export const MAX_CHAT_MESSAGE_LENGTH = 500;
export const CHAT_MESSAGE_RATE_LIMIT = 5;
const CHAT_MESSAGE_WINDOW_MS = 5_000;
const NAME_PATTERN = /^[\p{L}\p{N}_.-]{2,24}$/u;

export function normalizeChatName(value) {
  const name = String(value ?? '').trim();
  return NAME_PATTERN.test(name) ? name : '';
}

export function resolveChatSignalUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return '';
  }
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/chat/signal'
  ) {
    return '';
  }
  return url.href;
}

function validPeer(value) {
  return (
    value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 80 &&
    normalizeChatName(value.name)
  );
}

function validIceServers(value) {
  if (!Array.isArray(value) || value.length > 8) return [];
  return value.filter((server) => {
    if (!server || typeof server !== 'object') return false;
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return (
      urls.length > 0 &&
      urls.length <= 8 &&
      urls.every(
        (url) =>
          typeof url === 'string' &&
          /^(stun|stuns|turn|turns):[^\s]+$/i.test(url),
      )
    );
  });
}

function validSignalPayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return false;
  if (type === 'ice')
    return (
      typeof payload.candidate === 'string' && payload.candidate.length <= 4_096
    );
  return (
    payload.type === type &&
    typeof payload.sdp === 'string' &&
    payload.sdp.length > 0 &&
    payload.sdp.length <= 12_000
  );
}

function normalizeChatMessage(value, peer, now) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.type !== 'chat' ||
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    value.text.length > MAX_CHAT_MESSAGE_LENGTH
  ) {
    return null;
  }
  const timestamp = Number(value.timestamp);
  return {
    id:
      typeof value.id === 'string' && value.id.length <= 80
        ? value.id
        : `${peer.id}-${now()}`,
    name: peer.name,
    peerId: peer.id,
    text: value.text,
    timestamp:
      Number.isFinite(timestamp) &&
      Math.abs(now() - timestamp) < 24 * 60 * 60 * 1000
        ? timestamp
        : now(),
  };
}

/**
 * Connect one browser to a shared signaling room and exchange chat over
 * encrypted WebRTC data channels.
 */
export function createPeerChat({
  WebSocketImpl = globalThis.WebSocket,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  randomId = () => globalThis.crypto.randomUUID(),
  now = Date.now,
} = {}) {
  const listeners = new Map();
  const peers = new Map();
  const receivedRate = new Map();
  let socket = null;
  let localPeerId = '';
  let localName = '';
  let iceServers = [];
  let destroyed = false;
  let sentWindowStarted = 0;
  let sentCount = 0;

  const emit = (type, value) => {
    for (const listener of listeners.get(type) || []) listener(value);
  };
  const emitError = (message) => emit('error', message);
  const emitParticipants = () => {
    emit('participants', [
      ...(localPeerId
        ? [{ id: localPeerId, name: localName, local: true }]
        : []),
      ...[...peers.values()].map(({ id, name, channel }) => ({
        id,
        name,
        connected: channel?.readyState === 'open',
      })),
    ]);
  };
  const sendSignal = (peerId, signalType, payload) => {
    if (socket?.readyState !== WebSocketImpl.OPEN) return;
    socket.send(
      JSON.stringify({
        type: 'signal',
        to: peerId,
        signalType,
        payload,
      }),
    );
  };
  const closePeer = (peerId) => {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    peer.channel?.close();
    peer.connection.close();
    receivedRate.delete(peerId);
    emitParticipants();
  };
  const announcePeerError = (error) => {
    emitError(error instanceof Error ? error.message : String(error));
  };

  const attachChannel = (peer, channel) => {
    peer.channel = channel;
    channel.onopen = emitParticipants;
    channel.onclose = emitParticipants;
    channel.onerror = () =>
      emitError(t('Chat channel to {name} failed.', { name: peer.name }));
    channel.onmessage = (event) => {
      if (peers.get(peer.id) !== peer) return;
      if (typeof event.data !== 'string' || event.data.length > 4_096) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const message = normalizeChatMessage(payload, peer, now);
      if (!message) return;
      const time = now();
      let rate = receivedRate.get(peer.id);
      if (!rate || time - rate.startedAt >= CHAT_MESSAGE_WINDOW_MS) {
        rate = { startedAt: time, count: 0 };
        receivedRate.set(peer.id, rate);
      }
      rate.count += 1;
      if (rate.count > CHAT_MESSAGE_RATE_LIMIT) {
        emitError(
          t('{name} is sending messages too quickly.', { name: peer.name }),
        );
        return;
      }
      emit('message', message);
    };
    emitParticipants();
  };

  const createPeer = (info, offerer) => {
    if (!validPeer(info)) return null;
    let peer = peers.get(info.id);
    if (peer) {
      peer.name = info.name;
      emitParticipants();
      return peer;
    }
    let connection;
    try {
      connection = new RTCPeerConnectionImpl({ iceServers });
    } catch (error) {
      announcePeerError(error);
      return null;
    }
    peer = {
      id: info.id,
      name: info.name,
      connection,
      channel: null,
      pendingIce: [],
    };
    peers.set(peer.id, peer);
    connection.onicecandidate = ({ candidate }) => {
      if (candidate)
        sendSignal(peer.id, 'ice', candidate.toJSON?.() || candidate);
    };
    connection.ondatachannel = ({ channel }) => attachChannel(peer, channel);
    connection.onconnectionstatechange = () => {
      if (
        connection.connectionState === 'failed' ||
        connection.connectionState === 'closed'
      ) {
        closePeer(peer.id);
      }
    };
    emitParticipants();
    if (offerer) {
      try {
        const channel = connection.createDataChannel('gev-global-chat');
        attachChannel(peer, channel);
        connection
          .createOffer()
          .then((offer) => connection.setLocalDescription(offer))
          .then(() => {
            const description = connection.localDescription;
            if (description)
              sendSignal(peer.id, 'offer', {
                type: description.type,
                sdp: description.sdp,
              });
          })
          .catch(announcePeerError);
      } catch (error) {
        announcePeerError(error);
        closePeer(peer.id);
        return null;
      }
    }
    return peer;
  };

  const applySignal = async (message) => {
    if (
      typeof message.from !== 'string' ||
      !['offer', 'answer', 'ice'].includes(message.signalType) ||
      !validSignalPayload(message.signalType, message.payload)
    ) {
      return emitError(t('The peer connection response was invalid.'));
    }
    let peer = peers.get(message.from);
    if (!peer && message.signalType === 'offer') {
      peer = createPeer({ id: message.from, name: 'Guest' }, false);
    }
    if (!peer) return;
    try {
      if (message.signalType === 'offer') {
        await peer.connection.setRemoteDescription(message.payload);
        for (const candidate of peer.pendingIce.splice(0))
          await peer.connection.addIceCandidate(candidate);
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        if (peer.connection.localDescription) {
          const description = peer.connection.localDescription;
          sendSignal(peer.id, 'answer', {
            type: description.type,
            sdp: description.sdp,
          });
        }
      } else if (message.signalType === 'answer') {
        await peer.connection.setRemoteDescription(message.payload);
        for (const candidate of peer.pendingIce.splice(0))
          await peer.connection.addIceCandidate(candidate);
      } else if (peer.connection.remoteDescription) {
        await peer.connection.addIceCandidate(message.payload);
      } else {
        peer.pendingIce.push(message.payload);
      }
    } catch (error) {
      announcePeerError(error);
      closePeer(peer.id);
    }
  };

  const onServerMessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return emitError(t('The signaling server sent an invalid response.'));
    }
    if (!message || typeof message.type !== 'string')
      return emitError(t('The signaling server sent an invalid response.'));
    if (message.type === 'welcome') {
      if (
        typeof message.peerId !== 'string' ||
        !message.peerId ||
        !Array.isArray(message.peers)
      ) {
        return emitError(
          t('The signaling server sent an invalid room response.'),
        );
      }
      localPeerId = message.peerId;
      iceServers = validIceServers(message.iceServers);
      for (const peer of message.peers) createPeer(peer, true);
      emit('status', 'connected');
      emitParticipants();
    } else if (message.type === 'peer-joined') {
      if (validPeer(message.peer)) {
        createPeer(message.peer, false);
      }
    } else if (message.type === 'peer-left') {
      if (typeof message.peerId === 'string') closePeer(message.peerId);
    } else if (message.type === 'signal') {
      void applySignal(message);
    } else if (message.type === 'error') {
      const errors = {
        INVALID_MESSAGE: msg(
          'The signaling server rejected invalid connection data.',
        ),
        INVALID_JSON: msg(
          'The signaling server rejected invalid connection data.',
        ),
        INVALID_NAME: msg(
          'Choose a valid nickname: 2–24 letters, numbers, _, . or -.',
        ),
        ROOM_FULL: msg('The global chat room is full.'),
        RATE_LIMITED: msg('Signaling rate limit reached; try again shortly.'),
        INVALID_SIGNAL: msg(
          'The signaling server rejected invalid connection data.',
        ),
        UNKNOWN_PEER: msg('That chat peer is no longer in the room.'),
      };
      const text = Object.hasOwn(errors, message.code)
        ? errors[message.code]
        : msg('The signaling server refused the connection.');
      emitError(t(text));
    }
  };

  return {
    connect({ url, nickname }) {
      if (destroyed) throw new Error(t('Chat has been disposed.'));
      if (socket) throw new Error(t('Disconnect before reconnecting.'));
      const name = normalizeChatName(nickname);
      if (!name)
        throw new TypeError(
          t('Choose a valid nickname: 2–24 letters, numbers, _, . or -.'),
        );
      const signalUrl = resolveChatSignalUrl(url);
      if (!signalUrl)
        throw new TypeError(t('Use a secure WSS URL ending in /chat/signal.'));
      if (typeof WebSocketImpl !== 'function')
        throw new Error(
          t('This browser does not support WebSocket signaling.'),
        );
      if (typeof RTCPeerConnectionImpl !== 'function')
        throw new Error(t('This browser does not support peer-to-peer chat.'));
      localName = name;
      emit('status', 'connecting');
      let currentSocket;
      try {
        currentSocket = new WebSocketImpl(signalUrl);
      } catch (error) {
        emit('status', 'disconnected');
        throw error;
      }
      socket = currentSocket;
      currentSocket.onopen = () => {
        if (socket !== currentSocket) return;
        currentSocket.send(JSON.stringify({ type: 'join', name: localName }));
      };
      currentSocket.onmessage = onServerMessage;
      currentSocket.onerror = () =>
        emitError(t('Could not reach the chat signaling server.'));
      currentSocket.onclose = () => {
        if (socket !== currentSocket) return;
        for (const peerId of [...peers.keys()]) closePeer(peerId);
        socket = null;
        localPeerId = '';
        emit('status', 'disconnected');
        emitParticipants();
      };
    },
    disconnect() {
      if (!socket) return;
      const current = socket;
      socket = null;
      for (const peerId of [...peers.keys()]) closePeer(peerId);
      localPeerId = '';
      current.close();
      emit('status', 'disconnected');
      emitParticipants();
    },
    on(type, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Chat listeners must be functions');
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
    send(text) {
      const messageText = String(text ?? '').trim();
      if (!messageText) return false;
      if (messageText.length > MAX_CHAT_MESSAGE_LENGTH)
        throw new RangeError(
          t('Messages must be {count} characters or fewer.', {
            count: MAX_CHAT_MESSAGE_LENGTH,
          }),
        );
      const channels = [...peers.values()]
        .map((peer) => peer.channel)
        .filter((channel) => channel?.readyState === 'open');
      if (!channels.length)
        throw new Error(t('No chat peers are connected yet.'));
      const time = now();
      if (time - sentWindowStarted >= CHAT_MESSAGE_WINDOW_MS) {
        sentWindowStarted = time;
        sentCount = 0;
      }
      if (sentCount >= CHAT_MESSAGE_RATE_LIMIT)
        throw new Error(
          t('Rate limit reached; wait before sending more messages.'),
        );
      sentCount += 1;
      const message = {
        type: 'chat',
        id: randomId(),
        timestamp: time,
        text: messageText,
      };
      const encoded = JSON.stringify(message);
      for (const channel of channels) channel.send(encoded);
      emit('message', {
        id: message.id,
        name: localName,
        peerId: localPeerId,
        text: messageText,
        timestamp: message.timestamp,
      });
      return true;
    },
    dispose() {
      if (destroyed) return;
      this.disconnect();
      destroyed = true;
      listeners.clear();
    },
  };
}
