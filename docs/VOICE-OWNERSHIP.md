# Realtime voice ownership

`realtimeController.js` composes the session and owns its status, UI bindings and
overall lifetime. It coordinates startup and shutdown. `realtimeFacade.js`
preserves existing methods and properties by delegation, without copying state.
The session adapter, action runner and backend interfaces remain unchanged.

| Owner                    | State and responsibility                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `realtimeConnection.js`  | Start generation, request cancellation, peer/data channel, acquired microphone stream and playback element       |
| `realtimeBackend.js`     | Token and SDP requests, their separate transports, the abort/timeout scope around both, and client-secret expiry |
| `realtimeTurns.js`       | Active and superseded responses, pending confirmations, deduplicated calls and action cancellation               |
| `realtimeRadio.js`       | Speaker ducking, prepared playback, stronger-action reservations and playback observers                          |
| `realtimeInput.js`       | Physical Space gesture, microphone mute, input/output meters and their frame/listener lifetime                   |
| `realtimeCost.js`        | Next-session preferences and the current session's model-bound meter                                             |
| `realtimeViewport.js`    | One retained image, bounded deletion identities and capture generation                                           |
| `realtimeDiagnostics.js` | Bounded error history and sanitized optional diagnostics                                                         |
| `turnMetrics.js`         | Per-turn latency and speech spans written to the debug log                                                       |
| `narration.js`           | Progress lines and the earcon while tools run; spoken through the turns owner                                    |
| `pointerContext.js`      | Pointer position, dwell pick and the current turn's pointer snapshot (session-scoped)                            |
| `referents.js`           | Numbered items from the latest result for `referent:n` (session-scoped)                                          |
| `resultDisplay.js`       | What the voice card shows for a result and which items it numbers (read by the card and `referents.js`)          |
| `gevActions.js` runner   | Analyst follow-up memory (session: `resetConversation()` on stop, `dispose()` on removal)                        |

The backend is replaceable per deployment: `realtimeController.js` accepts it as a
`backend` option and falls back to `createRealtimeBackend()`. Its two method
signatures live with [application construction](APPLICATION.md); what belongs here
is the ownership. The connection is the backend's only consumer in the application.
The connection reads credential metadata for diagnostics and cost accounting,
then passes the complete credential unchanged to `negotiate`. Client-secret expiry is refused inside the backend, not by the connection.
`realtimeOwners.test.mjs` drives whole sessions through a substitute that
implements only those two methods.

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
short control taps and text entry remain native. A claimed hold silences local playback when the Radio speaker guard permits it;
admitted speech retires the provider turn and supersedes its tool work. A denied local claim
preserves queued confirmation audio; a later native Gemini interruption retires
the old reply and cancels its handoff. A click-started session stays open-mic.
Gemini PTT waits for two consecutive 10 ms PCM windows above a low energy floor
before submitting pointer context, activity markers or audio. Up to 400 ms of
bounded pre-roll preserves speech onset; after admission, tails and pauses pass
through until release. An empty or near-silent hold submits no new provider turn
and clears its local pending-input state. It still silences existing local
playback as an explicit Space hold and revokes a pending Radio handoff. A silent
hold alone preserves the current provider/tool turn until its natural completion. This energy check is not a speech classifier:
very quiet input below the floor is suppressed and sustained loud noise can pass.
Open-mic capture and native automatic activity detection are unchanged.
Current, uncancelled tool calls receive one terminal output within their owning
provider conversation. Gemini suppresses calls retired by a session or local-turn
boundary, or cancelled by the server. OpenAI answers superseded calls with a
terminal refusal while the same conversation remains owned; callbacks from a
replaced conversation cannot publish into the new session.
New typed input supersedes old intent. Radio waits for the spoken confirmation and
verified muted playback. Eligible stronger Radio controls begin without waiting
for an older station lookup; a successful control cancels covered pending work.
Already committed selection and unrelated sibling calls retain their authority.
“Turn Radio on” enables the layer without selecting or playing a station;
playback requires an explicit play, listen or resume request. Radio playback
suspends an active voice session and remembers it until Radio is paused or
disabled. This also applies to manual playback; merely enabling the layer does
not suspend voice. Pausing or disabling Radio leaves a previously inactive
voice session off. Provider replacement or explicit voice Stop cancels the
saved resume; manually starting voice pauses Radio. A live cost meter stays
bound to its negotiated model,
even when the next-session preference changes. Clear standalone first-party
provider requests remain ordinary provider turns, so the active OpenAI or Gemini
model says in its normal voice, “I can’t switch voice providers directly. Hover
over the Voice panel and use the provider dropdown.” Hosts without at least two
distinct usable chooser options hide that control and
instead explain that provider selection is managed by the app. The built-in
endpoint defaults to this neutral guidance; the standalone host opts into chooser
guidance. No tool can change the selected provider. Authoritative typed requests and
recognized OpenAI speech block app actions; Gemini native-call refusal is
described below. These refusals never change or save provider state, reconnect
voice or remount a session. Ambiguous, quoted, negated, conditional and compound text
remains ordinary conversation. Manual selection is the only provider switching
path.

Gemini native tool calls are bound to the current socket, session epoch, local
turn and unique call ID. Native input captions are unordered advisory segments:
they are shown without authoritative request attribution and cannot grant or
revoke a tool's lifetime. First-party typed input retains its authenticated
request token through transport pressure, deferred delivery and same-turn
continuation, until real new input or Stop revokes it. An accepted fresh
`set_voice_provider` call refuses every not-yet-started tool for the rest of its
local turn; malformed or replayed calls cannot quarantine a new turn. No tool
changes or saves the selected provider, reconnects voice or remounts a session.

Gemini's sentence-level `ACTIVITY_START`/`ACTIVITY_END` signals track detected
speech, not proof that a reply generation exists. Automatic activity alone does
not retire an unanswered generation; observed server output or an explicit
submitted push-to-talk/typed request retains the reply fence. Local activity
owners preserve expiry liveness across an older retired completion, without
identifying server generations or granting tools authority. The old boundary
cannot clear a newer submitted request's pending reply. If expiry discards a
newest deferred request, the ordered retired boundary closes the session rather
than allowing its superseded forwarded predecessor to run under that request.
Shorter repeated expiry notices retain that supersession. A native terminal
completion settles even a silent user turn; pending tools, queued controls and
audio still delay presentation completion, and no speech or captions are invented.

Noise-only automatic activity may receive no generation. During expiry it can
wait with the microphone muted until the supplied deadline, capped at ten
minutes; no shorter no-evidence timer assigns reply identity. Native Live events
do not provide a VAD-sentence generation ID or guarantee their ordering relative
to tools. Local activity ownership cannot prove that arbitrary undelimited late
output belongs to an old generation; tools retain the socket/session/local-turn
and call-ID policy above.

There is no first-party typed-command UI. Embedders and programmatic `sendTextCommand`
callers can issue rapid typed requests while open-mic input is active. While a
typed request is deferred behind an older reply boundary, concurrent microphone
PCM may be discarded for up to that boundary's deadline. It is never replayed
under the typed owner's identity. `deferredAudioDrops.nonPttOwner` and
`deferredAudioDrops.closedActivity` report reason-specific lifetime-cumulative
counts alongside `droppedAudioChunks`; they do not change admission or recovery.

`sendTextCommand` return values are provider-dependent. Gemini returns `true`
when it admits the request locally (sent or queued) and `false` for empty input,
an expiring session or failed local admission. Its empty-input and expiry checks
precede connection validation; ordinary nonempty input requires an open socket.
Oversized text and some context or queue-limit violations throw. A queued request
can still be superseded or fail its bounded wait, which status events report.
OpenAI returns `undefined` for successful submission or connected empty input,
`false` when sending the user conversation item fails, and throws when it is not
connected. Local admission does not guarantee provider delivery or execution.

For authoritative typed input and OpenAI speech, provider classification
normalizes sentence punctuation at word boundaries, so "Switch to. Gemini."
still identifies the direct request. Later authoritative segments can cancel
cooperative pending resources, including generic and CCTV layer initialization.
Pending annotations and their deferred outlines use the calling voice operation's
cancellation signal. Stop, interruption and replacement cancel only that work;
already committed marks and unrelated annotation owners remain. Completed actions
and map-stack changes without caller cancellation cannot be undone. Gemini
captions do not supply cancellation authority.
Gemini retires old replies before forwarding deferred input; continued old output
refreshes its five-second inactivity bound while deferred-input deadlines stay
absolute. Stop and replacement invalidate both waits and their continuations.
OpenAI input with explicitly disabled or failed optional transcription retains
its authentic speech identity for ordinary tools. Missing, empty or untracked
input cannot supply tool authority, and provider switching remains manual.

OpenAI response reservations remain ordered: a delayed response must consume its
own slot. More than 16 unmatched reservations ends the owned session and shows
"Voice lost turn tracking. Start voice again." A deliberate restart restores a
fresh transport and turn tracker; it never automatically reconnects or assigns
old responses to new input. A missing response before overflow remains ambiguous
with a delayed one, so this does not establish native leak frequency or repair
every possible FIFO mismatch.

Run the unit suite and both live recorded-audio modes against a configured local
server:

```sh
node scripts/qa-voice-wav.mjs http://localhost:4173
node scripts/qa-voice-wav.mjs http://localhost:4173 --push-to-talk
```

The second mode uses the actual Space shortcut, verifies microphone acquisition
and release, and checks the same globe/Radio outcome. Tracking and scene-control
acceptance exercise voice's shared application operations separately.
