# ChatGPT plan usage for typed GEV commands

This provider extends the GEV COMMAND console from darrendignam's PR #976.
It uses the official open-source Sign in with ChatGPT preview. A ChatGPT
subscription alone does not grant generic API access: the user must authorize
plan usage, have an eligible account and select an available model. OpenAI API
keys, billing and limits remain separate. There is no automatic paid API fallback.

## Use

1. Run GEV locally and open GEV COMMAND.
2. Select **ChatGPT plan**, then **Continue with ChatGPT**. Authorization opens
   in your browser. If a popup is blocked, use the link shown in the console.
3. Review the permissions and plan usage allowance on OpenAI's authorization
   page. Return to GEV when the loopback callback confirms the connection.
4. Choose a model from that account's catalog and send a command. No voice
   session, microphone permission or API key is needed for this provider.
5. Use STOP to cancel inference and prevent remaining queued tool calls. It
   cannot undo an action that has already run, or forcibly interrupt every
   existing application action while that action is in progress.

The account selector keeps workspace registrations distinct even if they share
an email. Switching clears the conversation. A command remains bound to its
original account; if another tab changes accounts, reload the models and start
a new conversation. Closing the dialog only hides it; use STOP to cancel.

**Sign out / cancel sign-in** stops pending authorization or signs out the active
account. It keeps the client registration for a later login. If remote revocation
cannot be confirmed, the console says so; disconnect the app in ChatGPT Settings.
Other saved accounts remain signed in until explicitly selected and signed out.

The UI links to ChatGPT Settings for plan usage and access management. A limit
or permission error stops the request; switching to an API-key or local provider
requires an explicit user choice. Plan usage is not reported as free inference.

## Credentials and privacy

GEV stores its own account registrations and rotating tokens in
`~/.config/gods-eye-view/chatgpt/accounts.json`. `GEV_CHATGPT_AUTH_DIR` may select
a different private directory outside the repository. Do not copy credentials
from Codex or set an OAuth token as `OPENAI_API_KEY`. Nothing in this feature
reads or updates Codex's `auth.json` or changes the existing Realtime integration.

Writes use a fresh hardened file, fsync and atomic rename. Unix credentials and
their directory must be owned by the current user with no group/other permissions.
Windows reuses Provider Settings' DACL hardener and a non-mutating verifier:
every read checks the directory and account file; transactions also recheck the
lock and destination after an awaited update. Existing unsafe or unverifiable
permissions are rejected, not silently repaired. Newly created directories,
empty lock files and empty temporary files are hardened before use. The directory
and file must not be symlinks, and credential files must not have hard-link aliases.
A lock serializes token refresh across processes;
after an abnormal termination, stop all GEV instances before removing a stranded
`accounts.lock`. Never remove the lock while an instance may be refreshing.

### Globe rotation integration (2026-10-23)

The branch merges upstream main at `9d3548c2`, including #1225 via
`b2fb4a26`. #1225 remains an independent upstream camera feature; #1331 still
builds on #976 and keeps its commits and attribution.

Typed commands reuse the shared camera schema, instructions and action runner.
“Rotate the globe” defaults to right/continuous; explicit direction and speed
replace that motion. “Stop moving the camera” dispatches `move_camera` with
`motion: stop`. Manual camera input and supported navigation interrupt rotation.

The text loop adds channel-specific guards:

- A refused globe rotation or failed/cancelled/thrown Globe View reset ends the
  current typed request locally. Remaining sibling calls get explicit skipped
  results, preserving complete tool-call/result history. No follow-up inference
  can turn reset guidance into an unrequested reset or retry. A fresh explicit
  user command can try again.
- Reset-and-rotate executes sequentially; rotation is never dispatched after a
  failed reset. A successful reset does not prove the view has settled or fits:
  the real rotation admission check still decides.
- Camera preambles are withheld until tool execution. Fixed refusal replies
  distinguish a view requiring reset from a viewport requiring further zoom.
  Successful follow-up prose still comes from the selected model and must follow
  the shared resulting-state guidance.
- STOP propagates the command abort signal and freshness check to the existing
  action runner, combined with application teardown. It blocks queued dispatch
  and ignores late prose. Tools that honor cancellation can stop pending work;
  an admitted continuous motion can keep running. STOP does not rewind the
  camera or replace an explicit camera-stop command.

Reproduce the focused integration checks with
`node --test src/agent/cameraIntegration.test.mjs src/agent/agentLoop.test.mjs`.
They drive the shipped runner with real Cesium camera geometry and scripted model
responses, including insufficient framing, direction/speed, navigation, explicit
stop, reset failure and cancellation races. `node scripts/qa-agent-camera.mjs`
drives the actual console and a rendered Cesium viewer with scripted relay
responses and no external imagery. Set `PUPPETEER_EXECUTABLE_PATH` if needed.
Neither gate proves live ChatGPT interpretation or OAuth eligibility; the real
account release gate below remains open.

### Windows storage review (2026-10-23)

The review found a defense-in-depth gap: the original Windows writer checked its
temporary file's DACL, but `read()` checked only file type and size on Windows.
A later ACL change could therefore leave a store readable or writable by another
local principal while GEV continued using it. No remote exploit or cross-user
token theft was demonstrated by this review. Exploitability depends on the
effective permissions, directory ancestry and privileges on the actual machine.

| Condition                                                                 | Storage behavior after this change                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing account file or directory has an unsafe/unverifiable Windows ACL | Reject before reading token bytes or invoking the transaction callback; do not repair permissions.                                         |
| A new directory, lock or empty temporary file cannot be hardened          | Reject; never write credentials to that temporary file.                                                                                    |
| Permissions change while a transaction awaits refresh                     | Recheck before committing; reject and retain the previous committed account file. A remotely rotated token may then require a new sign-in. |
| Temporary-file verification, write, fsync or rename fails                 | Reject; attempt cleanup and preserve the previously committed store.                                                                       |
| A held lock is replaced                                                   | Refuse the commit and leave the replacement lock in place.                                                                                 |
| A competing process holds the lock                                        | Wait up to the configured deadline, then reject; do not steal the lock.                                                                    |

The Windows verifier requires inheritance disabled and exactly three explicit
FullControl allow entries: the current process user's SID, SYSTEM and the local
Administrators group. It rejects inherited entries, extra principals, denials,
missing/reduced grants and propagation-only entries. The owner must also be one
of these trusted principals: an otherwise restricted DACL does not protect a
file whose untrusted owner can rewrite that DACL. The same policy applies to the
store directory, because a writable directory can allow entry replacement or
lock deletion independently of the child file's write permissions.

The verifier shares the hardener's canonical, absolute Windows tool resolution
and isolated PowerShell module environment. It never invokes `icacls` to repair
an existing ACL. Ambiguous tool paths, identity/ACL query errors, nonzero exits,
signals and timeouts fail closed. Case-insensitive environment aliases cannot
override the verification target, expected SID or trusted module path.

Reads use an open descriptor and compare it with the pathname around ACL
verification and reading; transactions recheck their held lock before writing.
These checks detect ordinary replacements and in-place changes. A reader racing
an atomic commit can receive a storage error and retry, instead of accepting
inconsistent data. These are **not atomic Windows handle-based ACL checks** and
do not claim to eliminate all adversarial TOCTOU races. The configured directory
must be on a local filesystem that supports the checked Windows ACLs, beneath
trusted parent directories; this implementation does not audit all ancestors.
Malware running as the user, SYSTEM or an administrator remains outside this
storage boundary, as do privileged backups and already-open foreign handles.
ACLs are access control, not encryption at rest.

**Existing Windows installations:** a directory created by an earlier build may
still use inherited ACLs and will now be refused, even if its account file passes.
If storage is refused, stop GEV, inspect the directory and its parents, and revoke
GEV's authorization in ChatGPT Settings if exposure is possible. Reauthorization
in a fresh private GEV directory is preferable to trusting possibly modified
records. Select an absent final directory via `GEV_CHATGPT_AUTH_DIR` so GEV can
create and harden it. Remove only obsolete GEV account data after resolving any
exposure; do not remove Codex's `auth.json` or API-key configuration. Fixing an ACL
cannot retract credentials already copied or prove that saved data was unaltered.

Microsoft documents [file access checks and security descriptors](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights),
[directory deletion and DACL/owner rights](https://learn.microsoft.com/en-us/windows/win32/wmisdk/file-and-directory-access-rights-constants),
and [owner access rights](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/access-mask).

Commands, relevant tool results and conversation context are sent to OpenAI.
The conversation and encrypted reasoning continuation remain in browser memory,
with size/history bounds inherited from GEV COMMAND; they are not saved to browser
storage. `store:false` disables stored Responses continuation; it does not mean
inference happens offline or independently establish a provider retention policy.
This flow does not import your existing ChatGPT conversations.

## Protocol and integration boundaries

- OAuth uses a GEV-owned dynamic client, a stable opaque host UUID, PKCE S256,
  fresh state/nonce, an HTTP `127.0.0.1` callback and verified ID tokens. Granted
  plan-use scopes are checked separately from identity.
- ChatGPT management and inference refuse remote/LAN clients, foreign origins,
  forwarded/proxy requests and non-local Host headers. `HOST=0.0.0.0` does not
  expose this account's allowance. Remote hosted deployments are outside scope.
- The public `/v1/models` OAuth catalog and `/v1/responses` endpoint are fixed.
  No ChatGPT `backend-api`, arbitrary gateway, Codex token reuse or
  `/chat/completions` OAuth request is used.
- Responses uses HTTP/SSE, `store:false`, `stream:true`, namespaced function
  tools and replayed input. Unsupported preview fields and hosted tools are
  omitted. Only a completed response is converted into the shared validator's
  tool calls; functions execute through #976's existing browser action runner.
- API-key OpenAI/OpenRouter and local Ollama remain available. #1223's DeepSeek
  and MiMo provider work could be adapted independently to the same transport
  contract; this PR does not copy that panel or change HUD Summary.

## Verification and release gate

Run `node --test src/agent/*.test.mjs server/providers/agent/chatgpt/*.test.mjs`,
and `node scripts/qa-agent-chatgpt.mjs` for the real console with fixture
responses in en/es/ru/zh-CN at two viewport sizes. Then run the repository baseline: `npm test`, `npm run build`, `npm run test:track`
with a dev server, plus `node scripts/qa-agent-console.mjs --offline` for console
chrome. `--offline` does not certify inference. The focused tests use temporary
credential stores, locally signed fixture JWTs and synthetic Responses streams.
They never require real credentials or make a paid model call.

For storage-specific validation, run:

```sh
node --test src/keySetupHardening.test.mjs server/providers/common/credential-file.test.mjs server/providers/agent/chatgpt/store.test.mjs
```

Portable regressions cover simulated Windows ACL rejection, read-before-verify
prevention, hardening/query failures, temporary-file cleanup, changes during
awaited updates, lock replacement, timeout, queue recovery, and concurrent writes
from independent store objects and separate Node processes. POSIX mode checks run
on POSIX hosts. Simulated ACL outcomes do not execute or certify PowerShell/NTFS.
The native-only tests use synthetic files and real Windows tools to apply the
policy and then broaden a file/directory DACL, enable inheritance or add a deny
entry; those tests are skipped outside Windows. The existing Windows onboarding
CI job now runs both storage test files in addition to the shared hardener tests.

Native Windows execution remains a release gate until a successful run is
recorded. It should also include a second non-administrator account attempting
read/write/delete, ordinary and elevated launches, a 32-bit caller where
supported, and a custom path under trusted parents. Review unexpected ownership,
reparse points and filesystem ACL support there. CI being `action_required` means
execution needs authorization; it is not evidence that these tests passed or failed.

Before marking this integration ready, test with an eligible account: first
registration, returning sign-in, model discovery, a tool/result round trip,
refresh, STOP, quota/permission errors, two-account switching and revocation.
Record model/plan and sanitized outcomes, never tokens or authorization URLs.
Live OAuth and native Windows credential protection have not been certified by
these fixtures. The branch depends on #976; rebase the complementary commit after
that PR lands and rerun the relevant gates.

The protocol follows OpenAI's documentation reviewed on 2026-10-23:
[registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[accounts](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
and [function namespaces](https://developers.openai.com/api/docs/guides/function-calling).

## Voice panel integration (2026-10-26)

Integration branch: `integration/check-1299-1331-20261026`, starting at
`ded9dc656eac6e3216d5bcb49b75d56ee397eb0c` and merging upstream main
`fefd5cdcf14b80cfb8ac3c7c60f9a489aa2b3c8e`, including #1299. The existing
#976 dependency and its commits remain in the ancestry. Voice panel owners,
action implementations, schemas and preference semantics from main are retained.

A scripted model reproduced a typed-console failure: it could narrate success
before a panel tool ran, and could claim success in another inference round after
the tool returned unavailable, invalid or cancelled. COMMAND now suppresses that
pre-execution narration and ends the request locally on a panel/timeout refusal.
It records complete tool results, skips remaining sibling calls, and permits a
fresh explicit command. A literal unnamed `settings` target asks which panel was
intended. Ordinary natural-language clarification remains the model's job under
the shared manual; fixture routing does not certify a real model's interpretation.

`src/agent/voicePanelIntegration.test.mjs` uses the shipped agent loop and shared
runner with actual voice control/card/preference owners and a minimal DOM:

- Open/close Voice Preview, Voice Settings and the Provider Settings dispatch;
  direct Cockpit exit/reveal, with the voice connection idle throughout.
- Exact timeout values 0/1/7/60, invalid values, browser-storage readback, Preview
  disabled, and independent agent provider choice/history/reset.
- Unavailable hosts, disposed panels, manual presentation changes during pending
  Cockpit exit, keyboard tab selection/Escape/focus restoration and STOP before
  reveal/sibling effects. A panel cancellation does not undo an exited Cockpit.
- A deliberately false model confirmation cannot turn a refused tool into an
  announced success or a retry. The actual provider dialog lifecycle still needs
  the browser gate; the unit fixture supplies its open/close button callbacks.

Browser probe: `node scripts/qa-agent-voice-panel.mjs`. It composes the shipped
console, voice panel, provider dialog and runner, with synthetic provider status
and scripted inference at 1440x1000 and 800x800. Chromium could not start in this
execution environment: `process_singleton_posix.cc`, `socket() failed: Operation
not permitted`. No page loaded, so this is **blocked**, not a browser pass.
Keyboard/focus assertions in the minimal DOM are not graphical evidence. The
probe is committed for rerun in an environment that permits Chromium. Live
ChatGPT/OAuth, actual microphone, audio, physical devices and native Windows
remain outside this validation.

## Phone landscape integration (2026-10-27)

The compatibility check uses #1331 at `df5b5e62963c8c2c146b719e774ec2bec56530aa`
and #1429 at `6d2d3d126d4d033c5548aa41cc95e8718ff1c748`. The integration is
local and temporary (`integration/check-1429-1331` in the test checkout). #1429 is not merged into the COMMAND branch, and #976
remains in its existing history.

A browser run against the integrated application reproduced the launcher bug:
at 844x390 and 932x430 its center was inside the bottom tab bar, and a pointer
press opened Layers instead of COMMAND. Portrait also exposed a collision with
the voice bar. At the 320x220 console minimum, the input extended below the
window (input bottom about 320px, window bottom 232px at 844x390).

The COMMAND-owned correction follows `body.mobile-shell` and the actual tab,
voice and attribution geometry. It leaves the shell's gate, tab heights, stacking,
voice layout and actions unchanged. The launcher has a 44px minimum height and
clears intersecting controls. The console fits inside safe-area and visual
viewport bounds, reserves the idle voice controls on phones, and lets header,
account and transcript content scroll before displacing the command row. An
area smaller than the preferred 320x220 minimum wins, including a keyboard's
reduced visual viewport. Transient resizing does not overwrite the saved window;
dismissing the keyboard restores the intended geometry. All viewport/observer
listeners are disposed with the console.

### Reproduction

On the COMMAND branch and then on a temporary merge with #1429:

```sh
node scripts/qa-agent-phone.mjs
# On the temporary integration, also require the new landscape shell:
node scripts/qa-agent-phone.mjs --landscape-shell
```

`--record-before` records the same pointer/geometry observations without
requiring the correction. The gate starts its own Vite server and headless-shell
browser. `PUPPETEER_EXECUTABLE_PATH` can select an installed compatible browser.
The gate uses an isolated Vite dependency cache for each checkout. The same
process owns server and browser, which also works in environments with
isolated command network namespaces. The full application mounts normally; its
continuous globe draw loop is paused for the chrome measurements.

The gate covers 844x390, 932x430, 390x844, 320x568 and 1280x800. It uses actual
pointer presses to open/close COMMAND, resize to its minimum, operate each tab
and open/close Voice Settings. It checks input and close-button hit targets,
focus restoration, voice provider/mic/settings hit targets, 44px side insets and
a 21px bottom inset, and a simulated 190px visual viewport with a 20px offset.
Keyboard dismissal must restore the previous geometry. JSON measurements and
screenshots are written to `qa-artifacts/agent-phone/`.

The agent API is a fixture; the gate never submits inference or microphone
requests. Safe-area and keyboard signals are simulated, not physical-device
certification. External imagery/fonts may be unavailable in this environment;
this is application chrome/accessibility evidence, not a graphics, OAuth,
live ChatGPT or audio certification. Existing release gates still apply.

Final application geometry results (headless Chromium shell, Node 24.22.1):

| Viewport | #1331 corrected | Temporary #1429 + corrected #1331 |
| -------- | --------------- | --------------------------------- |
| 844x390  | Pass            | Pass, mobile shell active         |
| 932x430  | Pass            | Pass, mobile shell active         |
| 390x844  | Pass            | Pass                              |
| 320x568  | Pass            | Pass                              |
| 1280x800 | Pass            | Pass, desktop shell               |

The integrated 844x390 minimum window is 320x220 and contains its input. At
320x568 the window contracts to 308x220 to retain its edge margins. With 44px
side insets, a 21px bottom inset and the simulated keyboard, the narrowest
window is 220x157, from (50,26) to (270,183); its input and close control remain
pointer-reachable. The launcher also clears the visible attribution elements.

- Focused console/controller/markup tests: 73 passed.
- Existing ChatGPT browser gate: all eight locale/size combinations passed.
- Production builds: passed on both the corrected branch and integration.
- Existing voice-panel browser gate: fails at `qa-agent-voice-panel.mjs:186`
  (`panelOpen` remains true after Escape). The identical failure was reproduced
  on untouched #1331 `df5b5e6` in a separate worktree; it is not counted as a
  passing gate or changed by this correction.

- Existing full-application console gate: passed in offline ChatGPT mode,
  including opening, provider selection, attribution clearance, drag/resize,
  persistence and Escape dismissal. No model inference was attempted.
- Formatting (1,553 files), import/package boundaries and changelog checks:
  passed.
- Full ordinary suite with two concurrent workers: **9,085 passed, 7 skipped,
  0 failed**. All **15 allocation checks passed** separately on calibrated
  Node 24. Earlier runs overlapping software-GPU browser probes hit the
  analyst/KML timing budgets; the final run used unchanged budgets and separated
  the browser and unit workloads.

## Right-rail integration (2026-10-28)

Temporary test combination: #1331 at `1319e31fad41bc6d424d5e539e20ab66e34b3b99`
and #1425 at `8c788474db58a94796cda7c4282399d182b08303`. The latter is newer
than the originally reported 07:02 UTC update. Only #1331 receives the fixes;
#1425 is a temporary test dependency, not part of this branch's history.

Two command defects were reproduced. Street Level was absent from the shared
panel schema and runner's canonical targets, causing the panel refusal guard to
skip remaining sibling calls. It is now addressable as `street-level-panel`;
common Display and Street Level aliases dispatch through the same explicit
`setPanelCollapsed` route. The panel description is shortened to keep the
existing 52,000-character Realtime prompt budget; schema fingerprints and
explicit target expectations record the deliberate addition.

Separately, successful panel results described individual actions rather than
the resulting rail state. A scripted provider could claim that all panels were
open after later calls had closed the earlier ones. COMMAND now appends a fresh
`rightRailState` observation to the last tool result after every round. For
panel-only requests, the final displayed confirmation is derived from a fresh
observation, overriding contradictory provider prose. Mixed-tool requests retain
model narration with explicit resulting-state guidance and the observation as
evidence; this is not a deterministic semantic guarantee for arbitrary prose.
There is no new tool or direct panel mutation in the text session. The reader
activates only when the tab shell is mounted, records mobile expansion separately
from sheet visibility, and never writes focus, preferences, share state or panel
classes. A desktop invariant violation is reported as a failure, not repaired by
silently overriding the shell.

The temporary merge also exposed a test-only incompatibility: both branches add
a component import, bringing `style.css` to 39 lines (40 elements when split on
newlines). A pre-existing `<40` line assertion rejected the valid import shim.
The regression now checks that removing comments and imports leaves no CSS
rules; component rules remain forbidden without imposing a count of imports.
The only merge conflict was in `scripts/format-scope.json`; both sets of entries
were retained in the temporary test tree.

Regression coverage includes the four-panel batch, successive typed openings,
explicit close, focus retention, stored collapsed choices, restore-lane claims,
mobile independence, target aliases/schema, hidden/Cockpit observations and
reporting an invalid desktop owner count. The three shell integration tests
explicitly skip on #1331 alone because #1425's shell/test DOM are absent; the
snapshot, alias and schema unit tests run on both trees.

Reproduce the real-application browser gate after temporarily merging #1425:

```sh
node scripts/qa-agent-right-rail.mjs
```

It starts Vite, renders the shipped application and Cesium viewer, types into the
real COMMAND form, and uses scripted API responses without OAuth, a microphone
or paid calls. Chromium headless shell uses a DevTools pipe because ordinary
Chromium's singleton Unix socket is prohibited in this environment. The gate
covers Tactical/Operator/Minimal/Cyber; successive Display, CCTV, Street Level,
Context; four-call and CCTV→Context batches; explicit close; actual rendered
panel visibility; retained input focus; preferences on a root reload; a real
share link opened in a fresh browser context; Up/Down wrapping, Home/End, Enter,
Tab through the compact Radio slot into the panel and Escape focus return; and
independent mobile expansions and Cameras/Context/More sheets. Artifacts are
written under `qa-artifacts/agent-right-rail/`.

Validation (Linux, Node 24.22.1):

- Corrected #1331: ordinary suite **9,093 passed, 10 skipped, 0 failed**.
  Seven skips are the existing platform cases; three require #1425.
- Temporary combined tree: ordinary suite **9,182 passed, 7 skipped, 0 failed**.
  Both trees also pass all **15** separately serialized allocation checks.
  Ordinary suites use four concurrent workers; no unit deadline was relaxed.
- **11 new regressions**: six snapshot cases, one alias test, one schema test,
  and three combined-shell cases (the latter explicitly skip without #1425).
- `qa-agent-right-rail.mjs`: all seven groups pass, **62** scripted API rounds,
  no application page errors. It exercises the complete shipped application.
- Existing ChatGPT browser gate: **8 combinations pass** (en/es/ru/zh-CN at
  1280×800 and 800×800). Existing camera browser gate passes, including real
  rendered Cesium rotation, stop, navigation and refusal handling.
- Production builds pass on both trees. Formatting, import/package ownership,
  catalogs (2,752 entries per es/ru/zh-CN catalog), setup doctor, layer tokens
  and changelog validation pass on corrected #1331. The new observation module
  is registered with the existing application package owner.
- The broad tracking harness was attempted with offline imagery, but its Node
  HTTP preflight could not reach the Vite URL from this environment. No tracking
  result is claimed. The targeted browser gate reaches its local Vite server
  through Chromium and passes.

The existing `qa-agent-voice-panel.mjs` gate fails at its Escape assertion
(line 186): the voice pane stays open while COMMAND's active surface handles
Escape. The same assertion fails on an untouched checkout of `1319e31`, on
corrected #1331 alone, and on the combined tree. It is not a new right-rail
integration regression and has not been changed in this correction. No live
ChatGPT interpretation, account eligibility, physical-device keyboard, native
Windows or broad external-feed/tracking certification is claimed.

## Utilities compatibility with #1469 (2026-10-29)

COMMAND routes typed requests such as “mostrame Indicaciones”, “abrí Utilidades”
and “mostrame las herramientas para dibujar” through the existing
`show_data_layers_menu({layerId: 'directions'})` tool. In #1469 that tool finds
Directions' actual row and opens its containing `utilities-panel`. This reveals
controls; it does not enable Directions, activate Draw, create a mark or import a
file. Draw and Import remain hidden in Cockpit according to #1469's policy.

The new routing guidance is text-only. No Realtime enum, schema digest, shared
voice instruction or share-link format is enlarged. In particular, sending
`utilities-panel` directly to `set_panel_open` is still invalid. Before #1469
lands, the same reveal tool opens Data Layers; COMMAND reports that actual panel
rather than claiming Utilities or Draw is available there.

The typed loop suppresses speculative narration for the reveal operation and
reads back the returned panel from the DOM. It requires a successful result,
matching focused row when requested, and an expanded panel with no hidden or
CSS-hidden ancestor. Missing, rejected, cancelled, unapplied and silent no-op
operations terminate the request locally and skip sibling calls. A fresh explicit
request remains possible. Before final confirmation, COMMAND checks again so a
manual close during follow-up inference cannot become an “open” confirmation.
For mixed requests the console retains each tool result separately.

Temporary integration uses #1469 head
`6f93c21aaa212e857cb0e80fb952c77a2b8b2c61` and #1331 baseline
`7acd11bfa5469c21c5e1e2b843268c0b2aab95da`, plus this correction. The only merge
conflict was the end of `zh-Hant.json`; both COMMAND account messages and the two
new route-error translations were retained. The Utilities/Draw contribution and
that temporary merge are not included in #1331's branch.

Reproduce the integration browser gate with
`node scripts/qa-agent-utilities.mjs` after temporarily merging #1469. It uses the
real application, typed console, panel owner and shared runner, with scripted
provider replies (including deliberately false success claims). It checks all
three Spanish requests in Tactical and Cyber, the actual Directions row owner,
panel visibility, unchanged layer enablement, an invalid direct panel target, a
silent no-op owner and recovery with a fresh request. These are execution and
confirmation checks; they do not certify live model interpretation or OAuth.

Validation (Linux, Node 24.22.1):

- Corrected #1331: complete ordinary suite with four workers: **9,228 passed,
  12 skipped, 0 failed**. The 15 serialized allocation checks also passed.
- Combined #1331 + #1469: **327 agent tests passed**, five skipped, zero failed.
  All 12 new Utilities regressions pass. Chromium's real-application gate passed
  the six Spanish-command/layout combinations plus invalid-target, silent-no-op
  and fresh-request recovery checks. The gate uses scripted inference.
- The first complete combined run recorded 9,319 passes, 12 skips and two failures:
  an assertion still expecting the pre-HUD-change instruction sentence (corrected
  to the current resulting-state contract and passing in the complete agent run),
  and Traffic's timed “settled footprint” test. All 15 Traffic navigation tests
  passed in an isolated rerun. That initial combined run is not claimed green;
  no timing threshold was relaxed.
- Production builds, package/import boundaries, i18n and formatting passed on both
  trees (1,577 files on #1331; 1,582 combined). Catalogs remain complete: 2,759
  messages per locale on #1331 and 2,765 combined. Changelog validation passed;
  combined token validation against the #1331 baseline preserved all 32 tokens.
- The stale instruction assertion was inherited from the earlier HUD correction;
  production voice behavior and its payload are unchanged by this Utilities fix.
  Live ChatGPT interpretation, mobile interaction, external feed reliability and
  the broader graphics/tracking release gates were not certified here.
