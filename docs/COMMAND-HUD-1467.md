# COMMAND compatibility with Operator retirement (#1467)

Reviewed 2026-10-29 against COMMAND head
`9f2b2c5ccd01d2045f5d73306f6a083c30f4ca03` and asturksever's #1467 head
`e12614a13a3706809837d7f763da00e83c7a9fb8`.

## Ownership and temporary integration

The published COMMAND correction does **not** remove Operator on its own or
include the commits from #1467. Retirement, the UI/catalog removals, the permanent
share-code mapping and the live HUD fallback remain asturksever's independent
implementation. COMMAND continues to use the shared live `HUD_LAYOUTS` policy.
Two conditional regression cases are skipped until that policy retires Operator;
they both run in the combined tree.

The local integration applies #1467's three feature commits (`8b2c6993`,
`e693e665`, `e12614a1`) to the current COMMAND branch. This isolates the requested
feature from unrelated newer main changes and retains the original authors.
The tool-payload digest conflicts: COMMAND already has newer panel descriptions.
Reconcile it using the two explicit reviewed pins in `actionSchemas.test.mjs`:

- COMMAND alone: `01eb522d619c9a838a0e8f23b3417321867e8aedd2e0c98e942bfee565df637d`.
- COMMAND plus retirement: `a76545934d063400664a2515ac7ed638dc08e7ade9a0443015e6aa778966aa82`.

No digest is generated or accepted automatically. The historical argument-schema
check restores the historical Operator entry before comparing its existing pin;
the live schema, UI and validator are checked separately against current policy.

## Reproduced defect and correction

A scripted provider said "HUD Operator applied!" before a `set_hud` call and
again after the result. The uncorrected COMMAND loop displayed it and returned
success even when the real shared runner rejected the layout or applied another
layout. This is a scripted-provider reproduction, not evidence about a specific
live model's interpretation.

- Suppress speculative HUD narration. Use the observed result for the final HUD
  reply, rather than the provider's unverified confirmation.
- A failed, cancelled, thrown, unverifiable or normalized HUD operation ends the
  typed request locally, records skipped sibling tool results and permits a
  fresh explicit command. Do not infer another retry from a refusal.
- Report the layout and visibility actually observed, including a layout that
  succeeded before a visibility failure. Mixed commands label the last HUD tool
  result and direct the user to the other tool results rather than asserting
  that all operations succeeded.
- Give the shared voice result an English `say` line built from the same observed
  state. Both manuals require `hud.layout`/`hud.visible` readback. This follows
  the existing speech-envelope convention: `say` is model-facing English, not a
  new interface translation key.

## Regression coverage

`src/agent/hudIntegration.test.mjs` exercises the real action runner and public
StyleManager methods with a minimal viewer/control fixture, the typed agent loop
with scripted inference, and a Realtime function-call event through its output
channel. It covers applied layouts, visibility, rejected and normalized requests,
partial failure, thrown actions, suppression of false prose, skipped siblings,
complete tool-call pairing and a fresh command after refusal.

After integrating #1467 it also verifies:

- Exactly Tactical, Minimal and Cyber in the UI and shared tool schemas.
- Operator rejected by the server validator and the shared action runner.
- The retired compact wire code stays at index 1, and both compact and legacy
  `hud=operator` share state normalize to Tactical at the HUD boundary.
- Operator removed from all four catalogs, preserving the three current labels.
- Both shared manuals omit the old HUD recommendation/confirmation examples.

#1467's existing `hudAltitudeDatum.test.mjs` regression additionally runs the real
`IntelHUD.setVariant('operator')` fallback and checks its DOM dataset.

## Validation

Results are recorded below after executing the suites. No live ChatGPT account,
OAuth flow, model inference, microphone capture or audio playback is certified by
these scripted transport checks. The browser gate was attempted but Chromium is
not installed in this environment. Existing broader release gates remain open.

Executed locally on Linux, Node 24.22.1:

| Check | Result |
| --- | --- |
| Final combined HUD + schema + pointing/prompt regressions | 35 passed, 0 failed, 0 skipped |
| Final dedicated HUD regressions | 12/12 combined; 10 passed and 2 retirement-only cases skipped standalone |
| Combined HUD/schema/share/live-HUD focused run | 73 passed, 0 failed |
| Agent, console, schema and speech focused battery | 335 passed, 5 existing/conditional skips, 0 failed |
| Combined ordinary suite, four workers | 9,213 passed, 10 skipped, 3 timing failures |
| Isolated rerun of all three failing files, one worker | 59 passed, 0 failed; no deadlines changed |
| Production build | Passed standalone and combined; standalone rebuilt after final prompt consolidation |
| i18n | Complete: 2,759 messages per catalog standalone; 2,758 combined |
| Import directions / package ownership | Passed standalone and combined |
| Formatting / changelog validation | Passed; 1,574 source files checked |
| Browser console gate | Attempted; blocked because Chromium is not installed |

The three combined full-suite failures were the five-second KML subprocess
limit, a Traffic footprint timer assertion and the 200 ms huge-string bound
assertion. The files and their implementation are unchanged by this correction
and #1467. They all passed together in isolation (KML, Traffic navigation and
schema codepoints). This does **not** turn the original full-suite run green.

The initial standalone candidate had 9,211 passes, 12 skips and two failures:
the huge-string timing assertion and the total prompt budget. Consolidating the
new HUD rule into the existing confirmation rule fixed the latter without
relaxing the 52,000-character ceiling: the final standalone prompt is **51,909
characters**. Final combined prompt tests pass. An optional allocation run
passed the focus probe but was stopped before the overlay series completed;
no complete allocation-gate result is claimed.

To repeat the final targeted integration check after applying the three #1467
commits and resolving the pinned schema/manual changes:

```sh
node --test --test-concurrency=1 \
  src/agent/hudIntegration.test.mjs \
  src/voice/actionSchemas.test.mjs \
  src/voice/pointAndAsk.test.mjs
```

For the remaining relevant files, run the ordinary suite with the repository's
`buildUnitTestPlan(discoverUnitTestFiles())`, using `--test-concurrency=4` for its
ordinary test list; run the two allocation files separately as the official
runner specifies. Repeat the browser gates when Chromium is available and keep
live model/audio verification separate from the scripted transport evidence.
