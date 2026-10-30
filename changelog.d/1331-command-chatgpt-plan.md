- Add optional ChatGPT plan authorization and Responses inference to the existing
  GEV COMMAND console, with separate account storage, model discovery, cancellation
  and fail-closed tool dispatch. Builds on darrendignam's #976; voice and HUD Summary
  remain separate (radianx, #1331).
- Reverify Windows ChatGPT credential and directory ACLs on reads, reject unsafe
  permissions without repair, and harden locks with checks after awaited updates.
  Add failure, replacement and cross-process concurrency regressions plus native
  Windows CI coverage; document recovery and the remaining native release gate
  (radianx, #1331).
- Integrate upstream globe rotation into GEV COMMAND, block subsequent text
  actions after camera refusal or reset failure, and forward command cancellation
  to the shared runner. Add camera geometry, console and cancellation regressions
  without changing the upstream voice behavior (radianx, #1331).
- Integrate shared Voice Preview and Voice Settings with typed commands; report
  unavailable or cancelled panel operations locally instead of accepting a false
  model confirmation, preserving independent voice preferences and agent sessions
  (radianx, #1331).
- Keep COMMAND's launcher reachable above phone tabs and voice controls, fit its
  window to safe areas and keyboard visual viewports, and keep input reachable
  at the preferred minimum size. Add real-application phone/desktop browser
  regressions without merging or modifying #1429 (radianx, #1331).
  COMMAND observes the final vertical-tab rail state after panel actions and uses
  that state for panel-only confirmations, including independent mobile expansion.
  Street Level becomes an addressable shared panel target. Shell exclusivity,
  keyboard behavior, share links and preference ownership remain with the UI.

- Reconcile COMMAND and ChatGPT copy with #1430 Traditional Chinese, preserving
  all original contributor translations and locale behavior. Include the seven
  newer upstream messages in the existing COMMAND catalogs and exercise both
  Chinese scripts and the zh-TW alias in the browser gate (#1331).
- Confirm HUD changes in COMMAND and voice from observed layout/visibility;
  suppress false typed confirmations after rejection, normalization or partial
  failure. Add retirement integration regressions without incorporating or
  replacing asturksever's independent Operator removal in #1467 (#1331).
- Reveal Utilities through the existing Directions menu tool in COMMAND, without
  expanding the shared Realtime schema. Read back panel disclosure and visibility
  before confirming; stop locally on refusal or silent no-op. Add unit and real
  application browser regressions for temporary integration with #1469 (#1331).
- Prepare COMMAND for the independent Arabic/RTL locale: mirror initial window
  and launcher placement, preserve physical drag/resize and saved positions,
  isolate mixed-direction transcript codes and coordinates without rewriting
  tool data, and provide 32 Arabic account/console translations. Add desktop,
  phone, authentication-fixture and payload-preservation regressions (radianx,
  #1331; compatibility with #1479).
- Preserve canonical feed provenance in large COMMAND tool results and offer
  validated HUD caption queries with the current UI language. Retain partial
  section coverage and share localized caption state tags with voice (radianx,
  #1331; compatibility with #1488).
