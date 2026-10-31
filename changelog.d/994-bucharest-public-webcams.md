- Add an opt-in Bucharest public-webcam pack with Piața Romană, Cocor and
  Elitte Inn Skybar using native CCTV HLS playback. Romană and Cocor poses
  are visually calibrated estimates; Elitte's pose remains uncalibrated.
  Configure `CCTV_SOURCES_FILE=config/cctv_sources.bucharest.json`
  with `CCTV_FORCE_AUSTIN=1` to retain the worldwide feeds. Publisher
  attribution is retained; streams are fetched at runtime, with no bundled
  frames (cosmin-cucu, #994).
