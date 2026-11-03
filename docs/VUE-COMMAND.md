# GEV COMMAND on Vue / Pinia

## Provider disclosure and maintainer criteria — 2026-11-03

Upstream: `e5d15f24d5472b75f1d378d8e52fb5cc962bd908`.
Validated runtime tree: `cd7cdaf54d32959738cb5f50b3aece1b63215b98`.
The following documentation/screenshot update does not change runtime source.
Earlier validation sections retain their own revisions and scope.

The follow-up addresses the product/privacy and duplication concerns in
[the closure of #1223](https://github.com/bilawalsidhu/gods-eye-view/pull/1223#issuecomment-6587796973):

- Provider-specific notices identify command/tool-result destinations, including
  map/place context, in all eleven locales. OpenRouter's compatible-service
  override and potentially remote Ollama servers are not described as local.
  The existing ChatGPT plan permission, privacy notice and Settings link remain.
- The notice shares the existing scrollable header. A first phone attempt with
  a new sibling region failed the simulated-keyboard reachability check; the
  final header version passes the original assertions without relaxation.
- COMMAND continues to call the application's existing runner, server-defined
  tools and voice-derived manual. Main's typed input remains on its connected
  Realtime/Live session; COMMAND's HTTP conversation and account-bound Responses
  require neither that connection nor microphone permission. The existing
  history/content/byte limits and server-owned contract were not reimplemented.
- Four new coexistence regressions compose the real chooser, binder, portable
  voice session, COMMAND loop and shared runner, with scripted wire adapters.
  They cover voice replacement/stop before dispatch, independent COMMAND STOP,
  and application teardown. They do not certify arbitrary overlapping map writes
  or preserve shared pointer/referent memory across voice resets.
- Integrating #1488 activates formerly deferred HUD cases. Their fixture now
  supplies the current HUD readout publisher, matching upstream's view ownership;
  production HUD behavior is unchanged by this fixture correction.

| Check | Result |
| --- | --- |
| Full ordinary suite, four workers, Node 24.22.1 | 10,369 passed; 7 explicit skips; 0 failed |
| Production build on the final header version | Passed |
| Final ChatGPT Vue/browser fixture | 26 combinations: en/es/ru/zh-CN/zh-Hant/zh-TW/de/fr/it/pt/uk/ja/ar × 1280×800 and 800×800 |
| Full-application phone/desktop geometry | 10 combinations: en/ar × 844×390, 932×430, 390×844, 320×568, 1280×800; pointer targets, minimum size, safe areas and simulated keyboard passed |
| Final console/view/ownership selection | 52 passed |
| HUD provenance fixture after integration | 37 passed, no deferred cases |
| Adopted formatting, imports/package ownership, catalogs, changelog, layer ledger | Passed; 2,772 messages per locale; 34 published tokens, no new allocations |
| Allocation probes | 15 passed on pre-header tree `c4a0b03b23333994ebcb4dd85aa93ed71bca3029`; allocation runtime/tests are identical in the final header tree |

### Final upstream advance: #1308

During validation, main advanced to
`3ad3cc2ab773bb2d694a1e1605cf7ffe5d0dca46` through #1308. Its fifteen-file
Overpass admission/tracking-verifier change is included in the final candidate.
The only merge conflict was the format-adoption list; both sets of entries are
retained without duplicates. COMMAND's implementation and the client code
exercised by the browser gates are unchanged by this advance.

Combined runtime tree: `37750370bb238a97db4d31cee42d55ab968d57d9` (the next
change records this validation only). The final targeted selection passed
**561 tests, zero failures, two explicit native Windows skips**: all agent
suites, ChatGPT auth/storage/Responses, voice/COMMAND coexistence, Overpass
admission/proxy/source behavior, same-site gate, network keys, arrival-observer
regressions and HUD caption feed state. Production build, package boundaries,
formatting, catalogs, changelog and layer tokens were rerun on this combination.
The full-suite and browser counts above remain tied to their recorded tree;
they were not rerun solely for the independent #1308 advance.

Browser fixtures use Chromium headless shell 156.0.8078.47 and scripted
inference/account status. The full-application geometry gate mounts the shipped
application but intercepts agent endpoints. No real OAuth, microphone or paid
inference is used. Safe areas and keyboard viewport signals are simulated.

[Final provider notice and account controls, fixture screenshot](media/command-vue/privacy-en-desktop.png)

Live ChatGPT registration/returning login, model eligibility, refresh, quota,
two-account use and revocation still need an eligible real account. Native
Windows credential protection, hosted CI and broad external-feed/tracking gates
are not certified by these Linux fixture checks. The PR remains draft. The
original #976 contribution and attribution stay in the ancestry; no separate
merge of that open PR is required.


## Utilities follow-up — 2026-11-02

A guarded update detected the concurrent Vue/Pinia work at `a0c2998a` and
preserved that implementation, its history and its fixture screenshots.
The follow-up adds only the explicit `utilities-panel` target to the shared
panel schema/dispatcher and its instructions/tests; Directions keeps its
existing reveal route. No console presentation, account controls, transcripts,
geometry, locale state or panel ownership is replaced.

On this combined runtime, Linux/Node 24.22.1 passed 10,012 ordinary tests with
zero failures and 31 explicit platform/optional-integration skips, then all
15 allocation assertions. The focused agent/HUD/panel/schema selection passed
508 tests with 24 deferred #1488 joint cases. Build, formatting, all eleven
locale catalogs, import/package boundaries, changelog and token-ledger checks
passed. The browser evidence recorded below remains tied to its original
runtime; it was not rerun for the additive Utilities tool target. Live OAuth
and model-use release gates remain open.


Integration candidate for #1331, 2026-11-02. Base: upstream main
`151ce3dee72426193a85af71105ddcf62b7f2c28`, including the Vue migration
#1499 (`accfa1fa855d8dd0a2a655ccaac226a38d59fabd`). The existing PR remains
the contribution; no replacement PR is needed.

## Ownership and mounting

- `index.html` places `data-gev-view="agent-console"` beside the other page
  views. `mountApplicationViews()` renders `AgentConsoleView.vue` before
  `createApplicationTools()` wires `mountAgentConsole()`. Hosts may omit the
  view through the existing `omitViews` API. The retired build-time HTML
  expander and `agent-console.html` are not used.
- `gev-agent-console` is a presentation store on the page's shared Pinia.
  Vue renders provider/model options, cost, busy/STOP states, transcript rows,
  account controls, the popup fallback link and translated labels. Neither
  controller builds children inside Vue-owned nodes.
- `createAgentSession()` remains the command/history/cancellation owner;
  `mountChatGptControls()` remains the account/polling owner. The store holds
  public display snapshots, not credentials, model reasoning or another
  conversation history. Account changes still abort/reset the session and
  clear the visible transcript; requests keep their account binding.
- PanelChrome and its existing Pinia store remain the panel owners. COMMAND
  reads their final disclosure state instead of storing its own open panels.
  Desktop commands obey one panel per side, while phone panels may expand
  independently. The console remains a non-modal floating surface, not a new
  rail panel.
- Page language stays with the existing locale owner and vue-i18n binding.
  Views call `t()` during rendering. Status keys and their interpolation
  parameters survive a locale change; transcript and tool data stay byte-exact.
  The six newly available catalogs gain the COMMAND messages, and the retired
  Traditional Chinese keys are pruned without replacing upstream translations.
- Native dialog disclosure, drag/resize geometry, edited input, keyboard focus
  and scroll position remain imperative, as in the surrounding migration.
  Escape/Tab defer to a focused voice pane, rail panel, rail item or other
  dialog. Otherwise the console keeps its existing Escape/focus behavior.
  Late listings/command completions cannot re-present a destroyed console.

## Relationship to #976

This candidate is self-contained: it carries the existing typed-agent core and
its history rather than requiring a future merge of #976 to run or to be
reviewed. darrendignam's original core at
`afe30629b1fbea988193a201a2427d0c46c3e2bf` remains in the ancestry and remains
credited to that author. The ChatGPT addition and this Vue adaptation do not
change #976, its branch or its PR. There is no new duplicate contribution.

The earlier #1331 description's merge-order requirement is superseded by this
standalone candidate. Maintainers can still choose their integration order;
that does not create a runtime dependency on an open branch.

## Verification

Validation uses Linux, Node 24.22.1 and Chromium 153.0.8010.0. Browser inference,
account status and tool responses are scripted fixtures unless explicitly
labelled offline. No real OAuth grant, credentials, microphone session or paid
inference is used.

Runtime candidate: `ec56d7be02a5a9eef26bbf7bb031a0d08a06436d` (the following
commit records documentation and screenshots only).

| Check | Result |
| --- | --- |
| Ordinary unit/integration suite, four workers | 10,012 passed; 31 skipped; 0 failed |
| Serialized allocation probes | 15 passed |
| Build, full adopted formatting, import/package boundaries | Passed |
| i18n / layer tokens / changelog fragment validation | 11 complete translated catalogs, 2,762 messages each; 32 unchanged published tokens; valid fragments |
| ChatGPT browser fixture | 12 combinations: en/es/ru/zh-CN/zh-Hant/zh-TW × two sizes |
| Live locale + RTL fixture | 12 combinations: en/ar × six desktop/portrait/landscape sizes |
| Voice panel and console, including Escape | Both 1440×1000 and 800×800 passed |
| Actual rendered Cesium camera | Rotation, direction/speed, explicit stop, navigation and refusal/reset guards passed |
| Production application rails | Tactical/Minimal/Cyber, batched/sequential commands, preferences and fresh-context shared-link restore passed |
| Production rail controls (separate invocation) | Native Tab/Shift+Tab, Enter/Space, aria-pressed, panel Escape, independent mobile expansion and sheets passed |
| Production phone geometry | en/ar × 390×844/320×568: four passed, including safe areas, pointer hit tests, minimum size and simulated keyboard viewport |
| Full application console, offline | Mount, live endpoint listings, provider controls, drag/resize/persistence, Escape and no console/render errors passed |

The rail matrix and control phases were verified in separate invocations of
the same runtime candidate. `--controls-only` reruns the control/phone-sheet
phase without repeating the three desktop themes and share restoration.
Earlier attempts exposed stale QA selectors and an invalid Puppeteer key
chord; the scripts now use Vue rail buttons and explicit modifier key events.
A parallel browser attempt was terminated under load; the passing results above
come from completed reruns. No timeout or product assertion was relaxed.

Relevant commands:

```sh
# Ordinary suite, bounded concurrency (allocation probes run separately).
node --import=./build/registerVue.js --test --test-concurrency=4 \
  $(rg --files src server -g '*.test.mjs' | \
    rg -v 'focusAllocations.test|worldOverlayAllocation.test')
node --import=./build/registerVue.js --expose-gc --test --test-concurrency=1 \
  src/data/focusAllocations.test.mjs src/overlays/worldOverlayAllocation.test.mjs
npm run build
npm run format:check
npm run check:boundaries
npm run i18n
node scripts/qa-agent-chatgpt.mjs
node scripts/qa-agent-chatgpt.mjs --rtl
node scripts/qa-agent-voice-panel.mjs
node scripts/qa-agent-camera.mjs
node scripts/qa-agent-right-rail.mjs
node scripts/qa-agent-phone.mjs
```

`PUPPETEER_EXECUTABLE_PATH` selects the installed browser. `QA_AGENT_URL` can
point the phone/rail gates at a local production preview; otherwise they start
the dev server. The phone gate simulates the visual viewport, not a physical
mobile keyboard. The rail gate uses Vue's native buttons and `aria-pressed`,
not the retired tab-strip's custom Home/End behavior.

The original draft gates for eligible-account OAuth/model use, native Windows
credential enforcement and broader graphics/tracking validation remain open.
These fixture checks do not certify those unrelated release gates or approve
an independently open upstream proposal.

## Console fixture screenshots

These show the real Vue console with scripted account/model responses and no
globe or live OAuth. The English example includes mixed Arabic input; the phone
example uses the Arabic page locale.

![English console with mixed-direction input](media/command-vue/fixture-en-desktop.png)

![Arabic phone console](media/command-vue/fixture-ar-phone.png)
