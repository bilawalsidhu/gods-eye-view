- Add Gemeente Amsterdam's public traffic and ANPR camera register as an
  opt-in CCTV source pack (`CCTV_AMSTERDAM_ENABLED=1`). The city publishes
  where its cameras stand, not what they see, so these rows are marked
  `position-only` end to end: `/api/cctv/frame` and `/api/cctv/media` answer
  409 for them, health reports `position-only` rather than `degraded`, and the
  layer never requests a frame. They deliberately do not fall through to the
  Street View or synthetic placeholder a camera that is merely down still
  gets — an installation existing somewhere and a live frame being unavailable
  are different facts, and a Street View still is context about the location
  rather than evidence from the camera. The panel shows them as
  `NO PUBLIC FEED · POSITION ONLY`; they contribute surveyed positions and
  viewshed coverage like any other camera. Opt-in because the dataset names no
  open licence, only "openbaar, tenzij anders aangegeven" with an exceptions
  carve-out. The register's hardware `model` is passed through, so the Bosch
  MIC PTZs it names resolve against the datasheet table. Every other pack is
  unchanged and keeps the full fallback chain (Maher-Reven, ch-bas, #251).
