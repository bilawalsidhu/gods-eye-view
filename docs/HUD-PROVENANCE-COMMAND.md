# COMMAND / HUD provenance compatibility — 2026-10-30

This is a local compatibility exercise, not an approval or merge of upstream #1488.

## Revisions and isolation

- COMMAND #1331 started at `5fc14dad9c51ea0f336c8a3ad5761982729d1cda`.
- The fetched #1488 head was `7713fb8a` (newer than the request's `7b223d7d`). Its five topic commits, starting at `563df3ba`, were applied only on the local temporary branch `integration/check-1488-1331-20261030`.
- A full merge also pulled unrelated upstream main changes and conflicted in six files. It was aborted. The topic-only integration resolves HUD context conflicts while retaining COMMAND's existing context lookup and fail-closed display behavior. The temporary tree clears the last displayed summary before evaluating a new response; otherwise grafting #1488's cache-based display onto this older HUD retained an earlier generated summary after a rejected response.
- Additional pt/ja/other catalog registrations from upstream main were deliberately excluded. Three #1488 tests expecting those registrations fail on this older base. They are outside the requested en/es scope and are not reported as passing.
- The published COMMAND fix contains no #1488 aggregation, response schema, provider implementation, or topic commits. Its 24 dependent integration cases skip until #1488 is independently integrated.

## Reproduced problems and fixes

1. Large typed tool outputs could shed `feedProvenance`, or the entire catalog `data` object, leaving healthy-sounding generated prose without machine evidence. Preserve top-level `feedState` and `feedProvenance`, plus nested `data.feedState` / `data.feedProvenance`. Compact oversized provenance to its aggregate and five byte-exact layer identities/states, with an explicit omitted-row count. Ancillary prose is shed first. Unknown/null stays unknown.
2. `get_hud_caption` omitted the UI locale and treated section `partial` flags as nominal. Add injected presentation callbacks to the portable summary service; the standalone catalog supplies the current locale and translated section labels at call time. Classify explicit partial/degraded/stale section evidence. Portable tools do not import browser localization globals.
3. #1488's catalog caption begins with an English canonical state tag. The shared voice/COMMAND catalog adapter translates that exact, structured-state-matching prefix. It never infers a state from prose, and leaves unrelated tool outputs unchanged.
4. A full-suite run exposed that `get_hud_caption` was not offered at all: COMMAND advertised only the app action schemas, while the standalone catalog filtered the caption out. Add a typed-only schema derived from the actual catalog definition; use it for offering, argument validation, configuration counts and prefix-cost estimates. Allow this caption in the browser catalog's local override. The voice and MCP surface tables remain unchanged. A real server-handler test verifies that the tool is advertised and accepted without a correction round; a separate test executes the actual standalone catalog with a fake HTTP backend.
5. Both transports inherit a short structured-state rule. The detailed feed/HUD caption manual is typed-only; voice does not promise a caption tool it does not offer. Voice's prompt stays at **51,979 characters**, below its existing 52,000 limit. These are model instructions, not deterministic enforcement over arbitrary final model prose.

## Exercised scenarios

`src/agent/feedProvenanceIntegration.test.mjs` covers en/es × nominal/partial/degraded/stale:

- Actual shared action runner → current World Packet → typed tool-call/result/follow-up request. Compare with the HUD layer context and direct voice runner output. Every warning-state roster also contains a nominal neighbor.
- Actual catalog `get_hud_caption` → shared `withToolCatalog` adapter → typed loop. Feed the summary service a deliberately mismatched nominal state with healthy-sounding text; warning states must keep the canonical state and discard that text. Compare the console-loop final response with the shared voice tool output.
- Actual `IntelHUD._updateSummary` using a minimal DOM, matching structured summary, then a mismatched response. Check accepted text, localized warning prefix and deterministic fallback. The `mgrs` import is stubbed for Node; Cesium rendering is not exercised.
- Oversized top-level and nested tool results, null evidence, Unicode identifiers, explicit omissions and shared instructions. The locale/partial-context regression runs even without #1488.

The caption query uses the app’s existing HUD summary capability; ChatGPT plan sign-in does not configure that separate service, and no fallback inference is introduced. An unconfigured summary service remains unavailable.

The typed provider and summary responses are scripted fixtures. Passing these tests verifies execution, serialization and display contracts; it does not certify live ChatGPT language understanding or arbitrary model adherence to instructions.

## Validation

Node 24.22.1 / Linux.

- Temporary combined local commit `abc17db7` (tree `bd4399ca8a96254a4bfaf35e9d3ef3d9a5879d9e`): **130 passed, 2 skipped, 0 failed** across the focused agent/conversation/HUD/World Packet/caption/layer snapshot suites. The two skips are separate #1467 retirement gates. The integration-specific file enables all 24 combined en/es cases.
- Before the COMMAND corrections, the initial 33-case integration regression file reported **17 failed / 16 passed** (eight serializer cases, eight caption/locale cases, and the shared manual contract). This run already contained the temporary HUD fallback merge resolution.
- COMMAND alone: the final regression file reports **13 passed, 24 skipped, 0 failed**. Those 24 skips explicitly await independent #1488 integration.
- Production builds passed on COMMAND and on the temporary topic integration. Import/package boundaries passed. COMMAND i18n reports **2,759 complete messages** in each es/ru/zh-CN/zh-Hant catalog; the final formatting pass checked **1,581 files**. Changelog validation passed.
- The first ordinary full run reported **9,241 passed, 36 skipped, 2 failed**. Both failures were actionable: an instruction named an unavailable caption tool, and the voice prompt exceeded its budget. Both are fixed without relaxing either test; the focused routing/ownership/manual checks then passed **93 tests**, with 24 independent-#1488 skips. The final ordinary rerun at local commit `9ec40a72` passed **9,247 tests**, skipped **36**, failed **0** (four workers). Of those skips, 24 are the deliberate independent-#1488 integration gates. All **15 serialized allocation checks passed** (1 focus + 14 world-overlay workloads).

## Not completed

- Browser console QA was attempted: `node scripts/qa-agent-chatgpt.mjs` fails before page creation because its configured Chromium executable is absent. No visual console, focus, clipping or full-globe rendering pass is claimed.
- No live OAuth, model inference, real weather/feed availability, microphone/audio, native Windows or hosted GitHub CI certification. No credentials or paid inference were used.
- The complete ordinary suite on the temporary combined tree was not certified; the three unsupported-locale failures above remain explicitly recorded.

## Reproduction

Run `node --test src/agent/feedProvenanceIntegration.test.mjs` on COMMAND alone. Independently integrate the recorded #1488 topic changes in a temporary tree, retain COMMAND's fallback behavior, then rerun it to enable the 24 combined cases. Run the focused agent/conversation/HUD/World Packet/layer snapshot suites, `npm run build`, `npm run check:boundaries`, `npm run i18n` and `npm run format:check`. Run ordinary tests with four workers and the allocation probes separately on Node 24.

## Follow-up against current #1488

Rechecked COMMAND head `bf05ba9f` with upstream #1488 head
`dbfbfcceb90123b49823c9a9dcb42a9402f70e45` in an isolated topic-integration
worktree. The latest HUD commit applies on the previously reconciled integration
without textual conflicts. Its locale registrations and six added base catalogs
were included from that upstream head so Japanese/CJK checks run with the actual
shipped locale vocabulary. These integration-only changes are not part of the
published COMMAND branch and are not an approval or merge of #1488.

The newer HUD deliberately avoids inference without a named place. The minimal
COMMAND HUD fixture previously supplied only layers, so its eight acceptance
cases no longer reached the summary service. Supply a named Austin label while
retaining the production layer/provenance context, as the upstream HUD harness
does. Canonical-state mismatch rejection assertions are unchanged. This is a
fixture contract correction; no production bypass of the named-place gate is
introduced. The upstream no-place tests still verify that inference is skipped.

Node 24.22.1 / Linux:

- Combined focused agent/HUD/caption/layer-snapshot selection: 122 passed,
  five skipped, zero failed. All 24 en/es combined provenance cases execute;
  the skips concern separate integrations. Locale/CJK checks now pass too.
- COMMAND alone: provenance file 13 passed, 24 deliberately skipped until
  #1488 independently lands; zero failed.
- Production builds passed for COMMAND and the temporary combination.
- Real browser fixture gate passed all 12 combinations on both trees:
  en/es/ru/zh-CN/zh-Hant/zh-TW at 1280x800 and 800x800. Includes tool round trip,
  account isolation, STOP, logout, sign-in copy and layout.
- Browser: Chrome Headless Shell 156.0.8078.47. The previous missing-executable
  blocker is resolved in this environment.

These are fixture-backed controls and integration contracts. Live OAuth,
ChatGPT model interpretation, real feeds, native Windows and hosted CI remain
separate acceptance gates. The upstream topic revision remains pinned above;
future changes need another compatibility check.

The fresh standalone ordinary suite passed 9,247 tests, skipped 36, failed 0
(four workers); 24 skips are the explicit independent-#1488 gates. Build,
formatting, i18n and package/import boundary checks passed. The built-app
offline console gate also passed: actual app mount, account/provider controls,
drag, resize, persisted placement, Escape teardown and no console/render errors.
Offline mode skips live inference.
All 15 serialized allocation probes passed with the original Node 24 budgets.
