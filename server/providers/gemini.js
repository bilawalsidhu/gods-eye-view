/**
 * @file gemini.js
 * @description Server-side proxy for Gemini Multimodal Live API.
 * Relays bidirectional WebSocket text/audio traffic with UTF-8 string encoding.
 */

import { WebSocket, WebSocketServer } from 'ws';

function geminiLiveProxy() {
  function installWebSocket(httpServer) {
    if (!httpServer) return;
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/realtime/gemini-live') {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nGEMINI_API_KEY not set');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          const upstreamUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
          const upstreamWs = new WebSocket(upstreamUrl);

          const messageQueue = [];
          let isUpstreamOpen = false;

          // Buffer client messages until Google's connection is open
          clientWs.on('message', (data) => {
            const text = data.toString('utf-8');
            if (isUpstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
              upstreamWs.send(text);
            } else {
              messageQueue.push(text);
            }
          });

          upstreamWs.on('open', () => {
            console.log('[Gemini Live] Connected to Google GenerativeService');
            isUpstreamOpen = true;

            // Flush the setup message to Google
            while (messageQueue.length > 0) {
              const text = messageQueue.shift();
              upstreamWs.send(text);
            }
          });

          // Forward Google's responses to the browser as text strings
          upstreamWs.on('message', (data) => {
            const text = data.toString('utf-8');
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(text);
            }
          });

          upstreamWs.on('error', (err) => {
            console.error('[Gemini Live] Upstream WebSocket error:', err?.message || err);
            clientWs.close();
          });

          upstreamWs.on('close', (code, reason) => {
            console.warn('[Gemini Live] Upstream connection closed:', code, reason?.toString() || '');
            clientWs.close();
          });

          clientWs.on('close', () => {
            if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
              upstreamWs.close();
            }
          });

          clientWs.on('error', (err) => {
            console.error('[Gemini Live] Client WebSocket error:', err?.message || err);
            upstreamWs.close();
          });
        });
      }
    });
  }

  return {
    name: 'gemini-live-proxy',
    configureServer(server) {
      installWebSocket(server.httpServer);
    },
    configurePreviewServer(server) {
      installWebSocket(server.httpServer);
    },
  };
}

export { geminiLiveProxy };