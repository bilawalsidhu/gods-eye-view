- Add the Reception Horizon layer (#714): what your own antenna can hear from
  where it stands. Per altitude band, the farthest position Local ADS-B heard
  in each 5° direction is drawn as a stepped 3D shell around the antenna,
  built only from this page session and never shared or stored. Only
  positions confirmed by the aircraft's previous fix count, and anything
  beyond line of sight is ignored. The antenna position comes from a click
  after SET ANTENNA, the decoder's `receiver.json` (new same-site
  `GET /api/local-receivers/receiver`) or the Radio card's LOCATE. Local
  ADS-B publishes its accepted fixes through `subscribeHeardFixes`.
  `scripts/fake-adsb-feed.mjs` serves a synthetic decoder for trying it
  without a radio, and `scripts/qa-reception-horizon.mjs` is the browser gate
  (Meet-1010, #1053).
