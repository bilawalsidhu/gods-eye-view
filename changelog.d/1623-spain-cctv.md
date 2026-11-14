- Spain's DGT road cameras join the CCTV mesh: the national DATEX II camera
  document is read at runtime, so the pack stays keyless and never ships a
  scraped snapshot (T3mpux, #1623). A still that more than one device record
  publishes becomes one camera, and is left out altogether when those records
  disagree on where the camera is by more than 500 m.
