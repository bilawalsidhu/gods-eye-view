import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export const CHAT_SIGNAL_PATH = '/chat/signal';
export const MAX_CHAT_SIGNAL_BYTES = 16_384;
export const MAX_CHAT_NAME_LENGTH = 24;
const JOIN_TIMEOUT_MS = 5_000;
const SIGNAL_WINDOW_MS = 10_000;
const MAX_SIGNALS_PER_WINDOW = 100;
const MAX_PENDING_CONNECTIONS = 12;
const NAME_PATTERN = /^[\p{L}\p{N}_.-]{2,24}$/u;

function validName(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CHAT_NAME_LENGTH &&
    NAME_PATTERN.test(value)
  );
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function reject(socket, code, message) {
  send(socket, { type: 'error', code, message });
  socket.close(1008, code);
}

function parseOrigin(origin) {
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function responseAndDestroy(socket, status, message) {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

/**
 * Attach a WebSocket signaling room with bounded signaling payloads and
 * pending handshakes to an HTTP(S) server.
 *
 * Chat text never passes through this server; it only forwards WebRTC
 * descriptions and ICE candidates between peers.
 */
export function installChatSignaling(
  httpServer,
  {
    allowedOrigins = [],
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }],
    now = Date.now,
    randomId = randomUUID,
  } = {},
) {
  if (!httpServer?.on || !httpServer?.off) {
    throw new TypeError('An HTTP or HTTPS server is required');
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError('At least one allowed chat origin is required');
  }
  const origins = new Set(allowedOrigins.map(parseOrigin));
  if (origins.has(null)) {
    throw new TypeError('Chat origins must be exact HTTP(S) origins');
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CHAT_SIGNAL_BYTES,
    perMessageDeflate: false,
  });
  const peers = new Map();
  let pendingConnections = 0;

  const broadcast = (payload, except) => {
    for (const [socket] of peers) {
      if (socket !== except) send(socket, payload);
    }
  };

  const removePeer = (socket) => {
    const peer = peers.get(socket);
    if (!peer) return;
    peers.delete(socket);
    broadcast({ type: 'peer-left', peerId: peer.id });
  };

  const onUpgrade = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      return responseAndDestroy(socket, '400 Bad Request', 'Bad request');
    }
    if (pathname !== CHAT_SIGNAL_PATH) {
      return responseAndDestroy(socket, '404 Not Found', 'Not found');
    }
    const origin = parseOrigin(request.headers.origin);
    if (!origin || !origins.has(origin)) {
      return responseAndDestroy(socket, '403 Forbidden', 'Origin not allowed');
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  };

  wss.on('connection', (socket) => {
    if (pendingConnections >= MAX_PENDING_CONNECTIONS) {
      socket.close(1013, 'too many pending connections');
      return;
    }
    let joined = false;
    let pending = true;
    pendingConnections += 1;
    const releasePending = () => {
      if (!pending) return;
      pending = false;
      pendingConnections -= 1;
    };
    let signalWindowStarted = now();
    let signalCount = 0;
    const joinTimer = setTimeout(() => {
      if (!joined) socket.close(1008, 'join required');
    }, JOIN_TIMEOUT_MS);
    joinTimer.unref?.();

    socket.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > MAX_CHAT_SIGNAL_BYTES) {
        return reject(socket, 'INVALID_MESSAGE', 'Invalid signaling message');
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return reject(socket, 'INVALID_JSON', 'Invalid signaling message');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return reject(socket, 'INVALID_MESSAGE', 'Invalid signaling message');
      }

      if (!joined) {
        if (message.type !== 'join' || !validName(message.name)) {
          return reject(socket, 'INVALID_NAME', 'Choose a valid nickname');
        }
        joined = true;
        releasePending();
        clearTimeout(joinTimer);
        const peer = { id: randomId(), name: message.name };
        peers.set(socket, peer);
        send(socket, {
          type: 'welcome',
          peerId: peer.id,
          peers: [...peers.values()]
            .filter((other) => other.id !== peer.id)
            .map(({ id, name }) => ({ id, name })),
          iceServers,
        });
        broadcast(
          { type: 'peer-joined', peer: { id: peer.id, name: peer.name } },
          socket,
        );
        return;
      }

      const currentTime = now();
      if (currentTime - signalWindowStarted >= SIGNAL_WINDOW_MS) {
        signalWindowStarted = currentTime;
        signalCount = 0;
      }
      signalCount += 1;
      if (signalCount > MAX_SIGNALS_PER_WINDOW) {
        return reject(socket, 'RATE_LIMITED', 'Too many signaling messages');
      }

      if (
        message.type !== 'signal' ||
        !['offer', 'answer', 'ice'].includes(message.signalType) ||
        typeof message.to !== 'string' ||
        !message.payload ||
        typeof message.payload !== 'object' ||
        Array.isArray(message.payload)
      ) {
        return reject(socket, 'INVALID_SIGNAL', 'Invalid signaling message');
      }
      const target = [...peers.entries()].find(
        ([, peer]) => peer.id === message.to,
      );
      if (!target || target[0] === socket) {
        return reject(socket, 'UNKNOWN_PEER', 'Chat peer is unavailable');
      }
      const encodedPayload = JSON.stringify(message.payload);
      if (
        Buffer.byteLength(encodedPayload) > MAX_CHAT_SIGNAL_BYTES / 2 ||
        (message.signalType === 'ice' &&
          (typeof message.payload.candidate !== 'string' ||
            message.payload.candidate.length > 4_096)) ||
        (message.signalType !== 'ice' &&
          (message.payload.type !== message.signalType ||
            typeof message.payload.sdp !== 'string' ||
            message.payload.sdp.length > 12_000))
      ) {
        return reject(socket, 'INVALID_SIGNAL', 'Invalid signaling payload');
      }
      send(target[0], {
        type: 'signal',
        from: peers.get(socket).id,
        signalType: message.signalType,
        payload: message.payload,
      });
    });

    socket.on('close', () => {
      clearTimeout(joinTimer);
      releasePending();
      removePeer(socket);
    });
    socket.on('error', () => {
      clearTimeout(joinTimer);
      releasePending();
      removePeer(socket);
    });
  });

  httpServer.on('upgrade', onUpgrade);

  return {
    close() {
      httpServer.off('upgrade', onUpgrade);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
    get participantCount() {
      return peers.size;
    },
  };
}
