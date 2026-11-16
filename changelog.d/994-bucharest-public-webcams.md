- Add an opt-in Bucharest public-webcam pack with Piața Romană, Cocor and
  Elitte Inn Skybar using native CCTV HLS playback. Romană and Cocor poses
  are visually calibrated estimates; Elitte's pose remains uncalibrated.
  Configure `CCTV_SOURCES_FILE=config/cctv_sources.bucharest.json`
  with `CCTV_FORCE_AUSTIN=1` to retain the worldwide feeds. Streams are
  fetched at runtime, with no bundled frames. The data credit is labelled
  "when enabled" and names the camera operators, who hold the video rights
  under WebcamRomania's terms; no operator permission is asserted
  (cosmin-cucu, #994).
