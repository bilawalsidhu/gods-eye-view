# Federated globes (peer federation)

Two or more God's Eye View instances running the LOCAL voice assistant
(`AI_PROVIDER=ollama`) can share spoken alerts and saved places. Each instance
keeps its own globe, session, memory and models; only two kinds of message
cross between them.

## Configuration

Set on every instance that should take part (`.env` or the environment):

| Variable        | Meaning                                                                                                                   | Default                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `GEV_PEERS`     | Comma-separated companion-hub URLs of the OTHER instances: `ws://host:port/api/voice/remote`. A bare `host:port` means that path; `http(s)://` is rewritten to `ws(s)://`. | empty (federation off) |
| `GEV_PEER_NAME` | Display name of THIS instance as peers hear it ("From Office: …").                                                       | `os.hostname()`         |

Federation is a mesh: point every instance at every other one. Example for two
desks on one LAN, one serving on 4326 and the other on 4327:

```
# desk A (PORT=4326)
GEV_PEER_NAME=Desk A
GEV_PEERS=ws://192.168.1.51:4327/api/voice/remote

# desk B (PORT=4327)
GEV_PEER_NAME=Desk B
GEV_PEERS=ws://192.168.1.50:4326/api/voice/remote
```

A peer's dev server must listen on the LAN (`HOST=0.0.0.0`, see
`docs/REMOTE.md`) unless both instances run on the same machine. Peers dial
each other at startup and reconnect with exponential backoff (1 s doubling to
30 s), so start order does not matter.

## What is shared

| Direction         | What                                                                                                            | How it shows up on the other globe                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| alerts, outbound  | every spoken alert (`notice` frame): watch alerts from `watch_add`, anything sent to the session as `notify`    | spoken by the active voice session as "From <peer>: …" and shown on its companion remotes; with no session open it still reaches the remotes |
| places, on demand | one saved place at a time, when the user says `share_place` ("share home with the other globe")                 | saved into that globe's memory as `<name> (from <peer>)` and toasted; `go_to_saved_place` flies there                                 |

Nothing else crosses: no transcript, replies, audio, camera position or tool
calls. Alerts are shared automatically; places only when asked.

Voice tools (`src/voice/tools/peers.js`):

- `peers_list` — names, URLs and connection state of the configured peers.
- `share_place {name}` — looks the place up in local memory (`recallPlace`)
  and posts it to every connected peer.
- `share_alerts {enabled}` — stores a per-browser preference under the
  localStorage key `gev:voice-peers:share-alerts:v1` (`"1"`/`"0"`, default
  on). Read it with `readShareAlerts()` from `src/voice/peerFrames.js`. The
  server-side hub currently mirrors every notice regardless; the adapter is
  the place to honour the flag (skip the `notify` frame for a watch alert when
  it is off).

HTTP: `GET /api/voice/peers` → `{ name, peers: [{ name, url, connected,
lastSeen }] }`; `POST /api/voice/peers {op:'share_place', place:{name, lat,
lon, alt?, heading?, pitch?, roll?}}` → `{ ok, place, sent: [peerName],
peers }`.

## How it is wired

- `server/providers/ollama/peers.js` — `createPeerLink()` (one reconnecting
  client per peer) and `createPeerFederation()` (forwarding rules, `sharePlace`).
  Each link is an ordinary remote client of the peer's companion hub
  (`/api/voice/remote`); it sends `{type:'hello', peer:{name}}` first and the
  hub replies with its own name.
- `server/providers/ollama/routes/peers.js` — installs `/api/voice/peers`
  and starts the federation when a real HTTP server exists (dev and preview;
  unit-test installs get an idle federation). Registered through
  `routes/index.js`.
- `server/providers/ollama/remote.js` — the hub accepts `hello` (records the
  peer name, answers with its own), accepts `peer_place` from a remote
  (mirrors it to its remotes and hands it to the local voice session), and
  stamps published envelopes with `peer: <hub name>` once federated.
- `server/providers/ollama/voice.js` — the session registers two more hub
  handlers: `notify(text, {origin})` speaks a peer alert through
  `speakNotice`, `deliver(frame)` sends a frame (the `peer_place`) to the
  browser. `speakNotice` copies `origin` into the `notice` frame it emits.
- `src/voice/peerFrames.js` — `applyPeerFrame(frame, { memory, toast })`
  stores an incoming `peer_place` as `<name> (from <peer>)`; the adapter
  calls it for frames it does not otherwise handle. Peer alerts need nothing
  in the browser: they arrive as normal `notice` frames.

Loop protection: every frame a hub emits on behalf of a peer carries
`origin` (the display name of the instance it came from), and a link never
forwards a frame that already has one. In a mesh each alert is therefore
delivered once per peer; in a chain (A→B→C without A→C) it stops after one
hop. Notices are also capped at 400 characters and places are sanitized to
name + numeric camera fields on both ends.

## Security

The companion hub has no authentication: anyone on the network who can open a
WebSocket to `/api/voice/remote` can read the session transcript, inject typed
commands and now also inject alerts and places (browser pages from other
origins are refused, see the origin check in [REMOTE.md](REMOTE.md)). Peers
must therefore be trusted hosts on a trusted LAN (or reached through your own
VPN/tunnel), and the dev server should only be exposed with `HOST=0.0.0.0` on
such a network — see the warning in `.env.example`. A malicious peer can make
the assistant speak arbitrary text ("From <peer>: …") and plant saved places;
it cannot run tools, move the camera or hear audio. There is no TLS on the dev
server; use `wss://` URLs only when a reverse proxy terminates TLS in front of
the hub.

## Checking it

`npm test` covers `src/tooling/ollamaPeers.test.mjs` (fake sockets for
connect/backoff, forwarding and loop rules, fan-out, the hub handshake, the
route, plus one live two-hub exchange on ephemeral ports) and
`src/voice/peerFrames.test.mjs` (browser side and the tool pack). For a manual
check run two dev servers on the same machine with `GEV_PEERS` pointing at
each other, open `remote.html` on the second, and either trip a watch alert on
the first or `POST /api/voice/peers` a `share_place`; the remote shows the
notice as "From <peer>" and the place as a `peer_place` frame.
