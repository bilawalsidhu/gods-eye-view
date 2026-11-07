- Expand CCTV coverage with a keyless Taiwan Highway Bureau fallback, 1,120
  Québec camera locations, City of Ottawa traffic cameras (needs a free city
  access certificate, `OTTAWA_CAMERA_CERTIFICATE`), and 2,230 curated
  image-backed cameras from Oregon and Japan (InoukT, #1506).
- Québec 511 in-browser video is opt-in (`CCTV_QUEBEC_VIDEO_ENABLED=1`) and
  loads only after the viewer presses Play; enforce provider-specific frame
  refresh limits, and report recognized MLIT maintenance images as degraded
  instead of healthy camera snapshots.
