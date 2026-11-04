- Add an Opacity slider (0-100 %, step 5, double-click to reset) under the row
  of every enabled layer that can be dimmed: Wind (flow lines, canvas fallback
  and the temperature/pressure field), Fire Perimeters, Drone Airspace, Sea
  Marks and Ski Pistes. The setting is shared as `?lop=<layer-id>:<percent>`,
  separate from the `#v=2` share codec and written only for layers below 100 %.
  A layer opts in with `setOpacity(fraction)`; the others show no slider
  (Byrd-IT, #1542).
