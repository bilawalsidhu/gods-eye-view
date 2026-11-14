- Add Singapore traffic cameras from the Land Transport Authority, through
  data.gov.sg, as a keyless CCTV pack. The camera list is one JSON request to
  `api.data.gov.sg/v1/transport/traffic-images` per catalog refresh, with a
  deadline, a 1 MiB cap and no redirects; frames are pinned to
  `images.data.gov.sg/api/traffic-images/`. The feed lists 8 cameras today
  (Woodlands, Tuas, Sentosa Gateway), named from LTA's OneMotoring camera
  page. Frames arrive as `application/octet-stream`, so the frame proxy reads
  that type as JPEG for this one directory only, when the body starts with
  `FF D8 FF`. Frame links change every 1 to 2 minutes, so the proxy looks up
  the current link at frame time, at most once a minute, and falls back to the
  catalog link. The Singapore Open Data Licence v1.0 notice is in the Data
  attribution popover. `CCTV_SINGAPORE_ENABLED=0` turns the pack off;
  `CCTV_SINGAPORE_MAX_SOURCES` sets the cap (pmxlr8, #1684).
