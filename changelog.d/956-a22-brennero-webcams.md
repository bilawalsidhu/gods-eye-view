- Add the Autostrada del Brennero (A22, Brenner–Modena) motorway webcams as a
  CCTV pack, the first Italian cameras. The 13-camera list is one keyless
  request to the Open Data Hub (NOI Techpark) tourism API, which republishes
  Autobrennero's own list with coordinates; frames are the operator's stills,
  refreshed about once a minute and pinned to each camera's own `km<N>.jpg`.
  Each camera's ground elevation comes from a per-kilometre DEM table, since
  the road climbs from the Po valley to the Brenner Pass. `CCTV_A22_ENABLED=0`
  disables the pack (Jibran Tahir, @jibraaan, #956). Closes #155.
