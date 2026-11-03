# Traditional Chinese / COMMAND integration — 2026-10-28

Temporary local branch: `integration/zh-hant-command-20261028`, based on
radianx's `feat/command-chatgpt-plan`. This initial validation was local; see the publication update below.

## Revisions and scope

- #1331, radianx: `1319e31fad41bc6d424d5e539e20ab66e34b3b99`.
- #1430, German Khokhlov and credited contributors:
  `d1ba0a7b8ad1bfca1d37f3700081348a5d4a0b95`.
- Trusted upstream/policy revision:
  `a4d3701c3cd62b46c90383973f38cfdbedf91889`. At inspection, #1430 was already
  merged at this revision; #1331 remained an open draft. The integration uses
  #1430's head as its second parent, preserving contributor history.
- Merge commit: `d2fa7d2`. The sole merge conflict was
  `scripts/format-scope.json`; both sets of entries were retained.

This is a localization compatibility candidate, not acceptance of the entire
OAuth/COMMAND feature or authorization to merge upstream. Existing #1331 release
gates continue to apply.

## Reconciliation

All 2,727 existing Traditional Chinese values were checked for exact equality
against #1430. No original translation or locale-normalization decision was
changed. The 31 requested COMMAND/authentication messages were translated, plus
the newer `zoom out to full planet view` placeholder present in the current
#1331 head. The resulting es, ru, zh-CN and zh-Hant catalogs each contain 2,759
messages. Message identifiers and `{envVar}` remain unchanged; the catalog
validator checks placeholders across all messages.

The seven newer upstream keys were merged into es, ru and zh-CN, with values
checked against #1430:

- `Check the spelling and press Enter to search again.`
- `Link shared`
- `Press Enter to try again.`
- `Shared vessel is unavailable`
- `This share link can't be opened`
- `{id} isn't reporting now — showing where it was at {time}`
- `{id} isn't reporting now — showing where it was last seen`

## Validation

Linux, Node 24.22.1, npm 11.9.0; fresh `npm ci`, no account credentials.

| Check | Result |
| --- | --- |
| `npm run i18n` | Four complete catalogs, 2,759 messages each |
| i18n and agent unit tests | 420 passed |
| Complete ordinary test plan, `--test-concurrency=4` | 9,198 passed, 7 skipped, 0 failed |
| Separate serialized GC allocation tests | 15 passed |
| `npm run build` | Passed; existing large-chunk warning |
| `npm run format:check` | 1,567 source files passed |
| `npm run check:boundaries` | Passed |
| `npm run doctor -- --json` | ready: true; optional credentials absent |
| `npm run layer-token:check -- --base-ref pr1331` | 32 published, 0 new, valid |
| `npm run changelog:check` | Passed |
| `node scripts/qa-agent-chatgpt.mjs` | 12 combinations passed |
| Built application: `qa-agent-console.mjs --provider chatgpt --offline` | Passed |
| `qa-agent-voice-panel.mjs` | Failed on Escape closing panel; same assertion fails on unmodified #1331 |

The full ordinary test plan was obtained with `buildUnitTestPlan` and
`discoverUnitTestFiles` from `scripts/run-unit-tests.mjs`, and run without the two
allocation files. Those two files were then run with `--expose-gc --test
--test-concurrency=1`; no tests or deadlines were weakened.

The browser gate uses the real console template, styles and controller with
fixture server responses. It covers en/es/ru/zh-CN/zh-Hant/zh-TW at 1280×800 and
800×800, exact authentication/model-cost/button/placeholder translations,
canonical document language, tool round trips, account isolation, STOP, logout,
pending sign-in copy and layout. Existing locale unit tests cover URL, stored
preference, browser language, persistence and script/region normalization.
`zh-TW` selects `zh-Hant`; `zh-CN` remains Simplified Chinese.

Standard Chromium was denied a Unix socket at startup. The installed Chromium
Headless Shell successfully ran the gates using `PUPPETEER_EXECUTABLE_PATH`.
Noto Sans CJK TC was installed in the disposable environment to inspect actual
Chinese glyphs; screenshots with missing-font boxes were replaced and the full
12-case gate passed again. The 800-pixel Traditional Chinese screenshot was
visually inspected. Local screenshots are in `qa-artifacts/agent-chatgpt/`.

The built-app gate checked mount, provider selection, dragging, resizing,
remembered geometry, Escape/teardown and no console/render errors. It skipped
inference explicitly. The browser pending-sign-in check uses a fixture popup;
it does not authenticate with ChatGPT.

## Findings and remaining limits

- Localization usefulness/design: pass within this scope. Both scripts remain
  selectable and all original author wording is preserved.
- Security: localization changes introduce no endpoint, credential handling,
  dependency or permission change. A full security acceptance review of #1331
  is outside this compatibility exercise.
- Tests/docs: localization gates pass. The adjacent voice-panel browser gate
  fails at line 186 on both the candidate and original #1331: after Escape,
  `panelOpen` is still true. The affected panel and keyboard modules are unchanged
  by this integration. No unrelated runtime fix was applied.
- Live OAuth, eligible-account inference, native Windows, full tracking/GPU
  regression and performance certification remain unverified. This text-only
  correction does not claim to clear those broader release gates.
- Automatic approval review rejected even `git push --dry-run` to the radianx
  fork, because remote publication was not considered authorized. No alternative
  publication mechanism was attempted. The candidate remains local for review.

Decision: catalog reconciliation is complete and locally validated; upstream
acceptance/publication remains pending, with the pre-existing voice browser
failure and original #1331 release gates explicitly outstanding.

## Publication update

The user explicitly authorized synchronization of radianx/main and publication
through the existing upstream PR #1331. radianx/main was advanced without force
from f0a1b22dc82c6c5cd9690d07c1cdb297818da86f to upstream
a4d3701c3cd62b46c90383973f38cfdbedf91889. The newer COMMAND head
04a570282221b409441502182830e4f673ae97d8 (right-rail corrections) was
merged into the localization candidate, preserving both sides of three metadata
conflicts. Upstream main was then merged explicitly; it made no content changes.

Publication will advance the existing feat/command-chatgpt-plan branch with a
lease against the inspected head, so the changes appear in the existing
bilawalsidhu/gods-eye-view PR #1331 rather than a duplicate PR. Contributor
history is preserved as merge parents; no upstream main write is attempted.

On the combined right-rail/localization tree, i18n (2,759 entries per catalog),
production build, all 12 locale/browser combinations, formatting (1,572 source
files), import/package boundaries and changelog validation passed again.
The complete ordinary suite was rerun with four workers; see the PR update for
its final result. The earlier native/OAuth/voice-panel limitations remain.
