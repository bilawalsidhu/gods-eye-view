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
