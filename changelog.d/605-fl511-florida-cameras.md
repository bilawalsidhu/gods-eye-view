- Add FL511 (Florida DOT) traffic cameras as an opt-in CCTV source pack:
  the statewide ArcGIS catalog, read a page at a time under a byte cap with
  redirects refused, and frames pinned to FL511's two image hosts over HTTPS.
  FL511's terms limit its content to individual, personal use, and any other
  use (a public deployment included) needs FDOT's express written consent, so
  the pack stays off unless `CCTV_FLORIDA_ENABLED=1`. Headings come from the
  catalog's direction codes, and camera ids come from the image channel, since
  the catalog's ID column repeats across regions. `CCTV_FLORIDA_MAX_SOURCES`
  sets the cap (Danielslay86, #605).
