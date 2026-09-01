# Task 5 report — isolated accessible workspace UI

## Outcome

Implemented the Demon Forge workspace as a hidden-by-default, user-opened local dialog. The controller is dependency-injected and uses only `document`, the encrypted local vault, and an explicit clock. It has no Cesium, data-layer, voice, share-link, or network dependency.

## Files changed

- `src/demonForge/controller.js`
  - exports `initDemonForge({ document, vault, now })`
  - returns `{ open, close, destroy }`
  - connects authorization/unlock, local JSON import, candidate review, local draft creation and approval, manual official-route opening, and the local hash-chained ledger
  - calls `parseSocialAnalyzerReport` with local file text only
  - keeps the official-route control disabled until explicit draft approval
  - opens the approved HTTPS route with `window.open(route, '_blank', 'noopener,noreferrer')`
  - appends `MANUAL_ROUTE_OPENED` locally after the manual opening
  - clears rendered candidate, draft, approval, and ledger text on close or lock
- `src/demonForge/controller.test.mjs`
  - adds dependency-injected fake-DOM coverage for hidden/open/close behavior
  - covers personal-text clearing and vault locking
  - covers Escape-key close
  - poisons network and globe globals to pin the no-fetch/no-globe boundary
- `index.html`
  - adds the `DEMON FORGE` opener with `aria-controls` and expanded state
  - adds the semantic `demon-forge-dialog`, hidden by default
  - adds authorization/import/review/draft/ledger sections
  - includes the required visible local-only copy
  - restricts the local file picker to `application/json`
- `style.css`
  - adds isolated responsive dialog styling and accessible focus/disabled states
- `src/main.js`
  - initializes Demon Forge immediately after normal `StyleManager` construction
  - passes only `document`, a Demon Forge vault, and `Date.now`

## Safety boundaries

- No `fetch`, upload, automatic search, automatic request, share-link, layer activation, globe, or voice call was added.
- The only external navigation is the explicitly approved, user-clicked official HTTPS route.
- Closing or locking the workspace locks the vault session and clears personal text from the rendered UI.

## Verification

- `git diff --check` completed with no whitespace errors.
- Static contract inspection confirmed the required dialog/opening copy, JSON MIME restriction, parser call, exact manual `window.open` options, and `MANUAL_ROUTE_OPENED` ledger event.
- Per the task instruction, no test or build command was run.

## Commit

Subject: `feat: add Demon Forge local workspace`

## Round 1 review fixes

- Added a session-generation guard immediately after the awaited local `file.text()` call. Closing, locking, destroying, or changing the vault session invalidates the pending import before parsing, rendering, or saving can resume.
- Expanded close/lock scrubbing to the complete draft surface: action, controller name, official route, approver, passphrase, case ID, file picker, rendered candidates, draft text, and ledger.
- Made manual official-route navigation fail closed and auditable:
  - `MANUAL_ROUTE_ATTEMPTED` must be saved successfully in the encrypted vault before `window.open` is called;
  - a failed durable save prevents navigation;
  - a null/blocked popup records `MANUAL_ROUTE_BLOCKED` and never claims `MANUAL_ROUTE_OPENED`;
  - a non-null popup records `MANUAL_ROUTE_OPENED` after the durable pre-navigation event;
  - session-generation checks prevent a close/lock racing the durable save from opening a route afterward.
- Completed modal behavior with background `inert`, Tab/Shift+Tab focus trapping, Escape close, inert-state restoration, and focus restoration to the Demon Forge opener.
- Moved the `DEMON FORGE` opener outside the `Globe actions` navigation landmark and gave it standalone fixed-position styling.
- Expanded the injected fake-DOM suite to cover stale imports, full control scrubbing on both close and lock, modal inert/focus behavior, durable-save failure before navigation, blocked-popup auditing, and successful audit/navigation ordering.
- Per task instruction, no test or build command was run for these review fixes.

Round 1 fix commit subject: `fix: harden Demon Forge local workspace`

## Round 2 review fixes

- Removed all success/blocked interpretation of the `window.open` return value. With `noopener,noreferrer`, both null and non-null returns now produce the same honest `MANUAL_ROUTE_HANDOFF_TRIGGERED` event after the durable `MANUAL_ROUTE_ATTEMPTED` pre-navigation event.
- The UI now states that the browser handoff was triggered while whether the official route actually opened remains unknown. Only a thrown `window.open` call records `MANUAL_ROUTE_HANDOFF_FAILED`; no path records or displays a claim that the route opened or was popup-blocked.
- Added `#demon-forge-open` to the clean-view, cockpit, and recording-mode hiding selectors so this standalone launcher follows the same exclusive-surface chrome policy as the former Globe actions location.
- Updated tests to pin identical null/non-null handoff semantics, thrown-call failure semantics, absence of `OPENED`/`BLOCKED` claims, and static coverage for all three exclusive-mode selectors.
- Per task instruction, no test or build command was run for these review fixes.

Round 2 fix commit subject: `fix: make Demon Forge handoff outcome honest`
