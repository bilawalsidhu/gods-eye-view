- Lines can fade with the age of their points (`LineItem.ageFade`, capability
  `lineAgeFade`), drawn by the renderer on the GPU on the scene clock, so a
  moving trail is not re-sent each frame; the Cesium renderer draws it, draped
  or not (samehkhamis, #1892).
