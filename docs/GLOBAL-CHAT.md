# Global chat

The minimized **GLOBAL CHAT** button opens a single live room. Everyone who
enters the same signaling-server URL joins that room. Chat normally travels
between browsers over WebRTC data channels, which use DTLS encryption. The
signaling server forwards peer offers, answers and ICE candidates; it does not
relay or persist chat text in normal operation.

## Run a signaling server

The chat service is separate from the app's local Vite server. It requires a
TLS certificate and private key and binds to loopback by default. Copy
`.env.chat.example` to `.env.chat` and configure:

```dotenv
GEV_CHAT_HOST=127.0.0.1
GEV_CHAT_PORT=4174
GEV_CHAT_TLS_CERT_FILE=C:\certs\chat.example.com.pem
GEV_CHAT_TLS_KEY_FILE=C:\certs\chat.example.com-key.pem
GEV_CHAT_ALLOWED_ORIGINS=https://your-app.example
```

The chat command loads only `.env.chat`; the service does not inherit provider
credentials from the app's `.env`. For a public endpoint, change the bind host
to `0.0.0.0` and use a publicly trusted certificate. `GEV_CHAT_ALLOWED_ORIGINS`
is a comma-separated list of exact app origins (scheme and host, with no path).
Open the configured port in the host firewall, then start the service from the
repository root:

```powershell
npm ci
npm run chat:server
```

Share `wss://chat.example.com:4174/chat/signal` with users of the app. They
enter that same URL and a nickname in the chat panel. The standalone service
requires `wss://` even on localhost, so the browser must trust the local
certificate when testing locally.

## Limits and privacy

- A room is limited to 12 participants because every browser forms a direct
  peer connection to each other participant.
- Nicknames are saved only in the user's browser. There are no accounts,
  reservations or verified identities; another participant can choose the
  same nickname.
- The signaling host sees nicknames, connection timing and ICE metadata.
  WebRTC candidates may reveal network addresses to the signaling host and
  connected peers. Because peers are not authenticated, a malicious signaling
  operator could impersonate participants or alter peer setup. Do not use this
  chat for sensitive messages.
- The default STUN server is Google's public STUN service. No TURN relay is
  configured, so some restrictive networks may be unable to connect directly.
- The first version has basic message and signaling rate limits, but no
  moderation, reporting, blocking or authentication. Only run a public room
  where that limitation is acceptable.

Use HTTPS for the app itself and keep the signaling server's TLS certificate
and private key private. Do not expose the app's Vite development server to the
internet as a substitute for this signaling service.
