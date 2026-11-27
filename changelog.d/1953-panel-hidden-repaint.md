- Stop repainting the Data Layers and Utilities rows, and the Weather and News
  readouts, while their panel is collapsed or hidden. A scene whose time
  advances (e.g. playback) refreshed them on every time step, re-rendering the
  whole layer list about every 1.4 s. They now repaint once, with current
  content, when the panel is displayed again, and a list whose rows have not
  changed is not rendered again (samehkhamis, #1953).
