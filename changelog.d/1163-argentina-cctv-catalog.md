- Add an opt-in Argentina webcam catalog with 64 checked feeds: 25 external
  players, 24 HLS streams and 15 still images. Includes the player and HLS
  prerequisites from #1162 and #1165. The dated survey preserves 115 leads: 18 resolved into 21
  additions, 70 discarded for restrictions or no current public feed, and 27
  other exclusions (including eight Misiones entries covered by #1145).
  Ten Varitech entries are excluded in favor of the separate opt-in pack in
  #1147, with their historical receipts retained in the survey. Coordinates
  are approximate area anchors; no camera pose is calibrated.
  Peatonal Dufaur shares its ID and approximate anchor with #1148 to avoid
  duplicating the stream when general packs are forced.
  (radianx, #1163).
- Resolve IPCamLive public snapshot aliases at request time through restricted
  HTTPS image-host redirects, keeping their short-lived addresses out of the
  runtime catalog. Include player/HLS prerequisites and operator credits.
  (radianx, #1163).
- Adapt external-player source and location labels to the shared status badges,
  preserving external/approximate semantics without redundant live-region
  updates; retain shared native controls and feature-owned calibration width.
  (radianx, #1163).

Reconcile upstream CCTV view thinning: retain the lightweight visible-camera
index and lazy full state alongside external players, off-screen selection,
active-camera persistence and no-public-feed handling.
