/**
 * WebSocket transport for the local Ollama voice server (AI_PROVIDER=ollama).
 * Same-origin by default so no key or token ever reaches the browser.
 */
export function createLocalWsBackend({
  path = '/api/voice/ws',
  WebSocketImpl = globalThis.WebSocket,
  location = globalThis.location,
} = {}) {
  let socket = null;
  function url() {
    if (/^wss?:/i.test(path)) return path;
    const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location?.host || 'localhost:4173'}${path}`;
  }
  return Object.freeze({
    protocol: 'ollama-local-ws',
    connect() {
      if (typeof WebSocketImpl !== 'function')
        throw new Error('WebSocket is unavailable in this browser');
      socket = new WebSocketImpl(url());
      socket.binaryType = 'arraybuffer';
      return socket;
    },
    send(value) {
      if (!socket || socket.readyState !== 1) return false;
      if (
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        (typeof Blob !== 'undefined' && value instanceof Blob)
      ) {
        socket.send(value);
      } else socket.send(JSON.stringify(value));
      return true;
    },
    close(code = 1000, reason = 'stop') {
      const current = socket;
      socket = null;
      try {
        current?.close(code, reason);
      } catch {
        /* Closing an already closed socket is fine. */
      }
    },
    get socket() {
      return socket;
    },
  });
}
