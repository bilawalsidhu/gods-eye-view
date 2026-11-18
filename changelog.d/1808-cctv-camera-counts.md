- Show how many cameras stand behind a thinned CCTV marker. Zoomed out, a
  ground cell with two or more cameras is one round marker with a small camera
  icon and the count (`999`, `1.7K`, `12K` in every language); it grows with
  the count, merges with a neighbour it would overlap, takes in a lone camera
  whose icon would sit against it, and a click zooms in until the group
  splits. The camera layer's colour is now green: count markers and idle
  single cameras share it, the active camera stays gold and live-video cameras
  stay violet. Cameras that share one mount draw side by side instead of as
  one icon with several callouts, and a camera the terrain height service
  never answered for stands on the drawn terrain instead of drifting under
  it (gekh, #1808).
