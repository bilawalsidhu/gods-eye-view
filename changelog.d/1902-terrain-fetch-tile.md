- Quantized-mesh terrain can supply its tiles through `fetchTile`, as `xyz`
  imagery does: Cesium still reads `layer.json`, schedules, cancels and
  decodes the tiles, and a `missing` tile draws its parent's terrain there
  (samehkhamis, #1902).
