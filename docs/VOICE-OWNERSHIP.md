# Realtime voice ownership

`realtimeController.js` composes the session and owns its status, UI bindings and
overall lifetime. It coordinates startup and shutdown. `realtimeFacade.js`
preserves existing methods and properties by delegation, without copying state.
The session adapter, action runner and backend interfaces remain unchanged.

| Owner | State and responsibility |
| --- | --- |
| `realtimeConnection.js` | Start generation, request cancellation, peer/data channel, acquired microphone stream and playback element |
| `realtimeTurns.js` | Active and superseded responses, pending confirmations, deduplicated calls and action cancellation |
| `realtimeRadio.js` | Speaker ducking, prepared playback, stronger-action reservations and playback observers |
| `realtimeInput.js` | Physical Space gesture, microphone mute, input/output meters and their frame/listener lifetime |
| `realtimeCost.js` | Next-session preferences and the current session's model-bound meter |
| `realtimeViewport.js` | One retained image, bounded deletion identities and capture generation |
| `realtimeDiagnostics.js` | Bounded error history and sanitized optional diagnostics |

Pure input policy, preferences and protocol-response policy have separate modules.
Owners receive named readers, operations or focused collaborators. Cross-owner
cancellation uses operations; response handling does not own Radio's reservations
or viewport deletion bookkeeping.

Shutdown first invalidates acquisition and action work, then closes transport,
stops audio analysis, releases media and clears conversation/input state. Full
removal also detaches UI, keyboard, annotation and Radio observers. Radio takeover
retains confirmed playback through that same shutdown path. A late offer, peer callback,
viewport capture or cancelled meter frame cannot enter a replacement session.
Action and post-capture continuations retain their conversation identity before
publishing output, queueing a response or changing status.

Behavioral invariants remain in force: a 500 ms Space hold claims push-to-talk;
short control taps and text entry remain native; a click-started session stays
open-mic. Every accepted or refused tool call receives its terminal output once.
New typed input supersedes old intent. Radio waits for the spoken confirmation and
verified muted playback. A live cost meter stays bound to its negotiated model,
even when the next-session preference changes.

Run the unit suite and both live recorded-audio modes against a configured local
server:

```sh
node scripts/qa-voice-wav.mjs http://localhost:4173
node scripts/qa-voice-wav.mjs http://localhost:4173 --push-to-talk
```

The second mode uses the actual Space shortcut, verifies microphone acquisition
and release, and checks the same globe/Radio outcome. Tracking and scene-control
acceptance exercise voice's shared application operations separately.
