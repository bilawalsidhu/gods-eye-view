# Arabic / RTL compatibility for GEV COMMAND (2026-10-29)

Tested #1331 at `7acd11bfa5469c21c5e1e2b843268c0b2aab95da` together with
gekh's independent #1479 at `ef5b44f2758a5dd594c996804cbdede55d10dbeb`.
The temporary integration is published on
[`integration/check-1479-1331-20261029`](https://github.com/radianx/gods-eye-view/tree/integration/check-1479-1331-20261029).
The final correction also preserves the concurrent Utilities update at
`7407522cf19969b973b244c0fe0b66317b55b457`, without changing its production files.
Only COMMAND fixes and its supplementary translations go into
`feat/command-chatgpt-plan`; #1479's locale registration, catalog, fonts, rail
mirroring, instruments and interpolation isolation remain independently owned.

## Reproduced and corrected

- In the uncorrected Arabic combination, the launcher and initial window stayed
  on the left. The console's initial desktop box was x=14, width=480 at 1440px;
  its corrected RTL default is x=946, ending 14px from the right. The launcher
  mirrors with right safe-area spacing on mobile. Saved physical positions are
  preserved. Reset uses the current document direction. Drag and eight resize
  directions retain their physical meanings.
- English user messages and tool rows inherited `rtl` in Arabic. Each natural
  language entry and the command input now uses `dir=auto`; machine tool rows,
  model/account selectors and the console's Latin title/caret stay LTR.
- A visual review reproduced reversed coordinate groups in Arabic prose.
  Display-only `bdi dir=ltr` fragments isolate coordinate pairs, Latin codes
  and code/value pairs, including `ABC-123`, `(-27.367, -55.896)` and `HDG 68°`.
  User/provider text is rendered through textContent. No Unicode controls or
  rewritten values enter commands, canonical IDs, tool arguments or results.
- The 32 additional COMMAND/ChatGPT strings fell back to English. Their Arabic
  translations live in `src/i18n/supplements/command-ar.json`. Runtime and catalog
  validation extend #1479's base catalog when it is present. This deliberately
  does not enable Arabic on #1331 alone or copy/modify gekh's base catalog. When
  both contributions land, these entries can be folded into `locales/ar.json`
  and the temporary supplement hooks removed.

## Browser evidence

Chromium Headless Shell 152, Linux, Node 24.22.1. Requests to the agent endpoints
use scripted fixtures, not a real ChatGPT account or paid model calls.

- **12 console combinations passed:** ar/en at 1440x900, 800x800, 390x844,
  320x568, 844x390 and 932x430. Checks include pointer drag/resize, initial
  position, input and independent transcript directions, mixed codes and signed
  coordinates, exact tool-result payloads, transcript scrolling, account switch
  isolation, STOP, logout, sign-in popup and Arabic pending-sign-in text.
- **10 complete-application combinations passed:** ar/en at 1280x800, 390x844,
  320x568, 844x390 and 932x430. Checks include launcher hit tests and attribution
  clearance, real shell/tab placement, minimum-size scrollable regions, input
  and close hit tests, voice controls, tab operations, safe-area refits and
  simulated keyboard viewport shrink/restore. These run the real application;
  external imagery/fonts may be unavailable. They do not certify GPU imagery.
- **12 standalone #1331 combinations passed:** en/es/ru/zh-CN/zh-Hant/zh-TW at
  1280x800 and 800x800, preserving the existing account/tool/STOP/layout gate.

[Arabic desktop](media/command-ar/ar-desktop.png) ·
[English desktop](media/command-ar/en-desktop.png) ·
[Arabic phone](media/command-ar/ar-phone.png) ·
[Application geometry report](media/command-ar/application-results.json)

## Automated validation and limitations

- Final standalone ordinary suite: **9233 passed, 12 skipped, 0 failed** with four
  workers on Node 24.22.1. All **15 serialized allocation checks passed**.
- Before the concurrent Utilities update, the complete temporary-combination ordinary suite: **9510 passed, 12 skipped,
  6 failed**. The six failures are exactly the de/fr/it/ja/pt/uk catalog checks
  described below; no additional failing tests were found.

- After preserving Utilities, combined agent/RTL/Arabic suite: **337 passed,
  5 skipped, 0 failed**, and the 12-combination RTL browser gate passed again.
- Combined focused console/RTL/Arabic suite: **72 passed, 0 failed**.
- Combined schema/HUD/instruction suite: **33 passed, 2 skipped, 0 failed**.
  The temporary schema pin includes #1331's existing `street-level-panel` target;
  it does not remove that target to match #1479's standalone digest.
- Production build and import/package boundary checks pass on both trees.
- Standalone #1331 localization: all four shipped catalogs complete (2759 keys).
  Combined Arabic/es/ru/zh-CN/zh-Hant catalogs complete (2763 keys).
- **The complete temporary integration's i18n gate is not green:** de/fr/it/ja/pt/uk
  each lack the same 32 COMMAND strings. Those six languages come from newer
  upstream changes carried by #1479 and are not shipped by standalone #1331.
  Translating them remains necessary before permanently merging the combined
  stack; Arabic itself has no missing strings. No empty/English filler was added.
- An obsolete #1331 instruction assertion expected wording replaced before this
  work. It now checks the current returned-state/ok=true contract; production
  instructions are unchanged by this correction.
- No live OAuth, real model routing, physical-device IME or native Windows
  certification is implied. Existing #1331 release gates still apply.

## Reproduce

```sh
# Standalone branch
npm run i18n
npm run format:check
npm run check:boundaries
npm run build
node --test src/agent/consoleBox.test.mjs src/agent/rtlIntegration.test.mjs
node scripts/qa-agent-chatgpt.mjs

# Temporary combination (Arabic must be registered by #1479)
node scripts/qa-agent-chatgpt.mjs --rtl
QA_AGENT_LOCALES=ar,en node scripts/qa-agent-phone.mjs
node --test src/agent/rtlIntegration.test.mjs src/agent/consoleBox.test.mjs \
  src/agent/agentConsole.test.mjs src/rtlLayout.test.mjs src/i18n/ar-display.test.mjs
```

Set `PUPPETEER_EXECUTABLE_PATH` to an installed browser if needed. Screenshots
and machine-readable geometry are regenerated under `qa-artifacts/`.
