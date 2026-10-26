- Turning a layer off frees the memory its entities held. Cesium kept
  removed layers' draw commands in reused per-pass arrays, so Data Centers
  kept 116 MiB after it was switched off, submarine cables 74 MiB and dams
  30 MiB; they now keep 13, 9 and 9 MiB (quanticsoul4772, #1367).
