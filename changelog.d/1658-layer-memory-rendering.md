- Reduce offscreen layer memory and repeated rendering work across aircraft,
  detection, transit, Street Traffic, satellites, CCTV, weather and infrastructure.
  Keep normal-mode aircraft crisp on a shared full-resolution surface, and add
  Show, Dim and Hide for grounded aircraft with tracked contacts kept visible.
  Preserve search and tracking, document workload-specific measurements, and
  offer an optional low-resource mode. Flush Cesium's pending billboard references
  when the final aircraft resident leaves or is removed, keeping offscreen
  contacts available for search and re-admission (Pierson Marks, @piersonmarks;
  cleanup review: @kvnloo, #1658).
