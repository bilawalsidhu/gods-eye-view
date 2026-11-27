- Join every data layer to the layer panel through one interface: the layer
  describes its row as data (`getRowControls()`) and calls `panel.invalidate()`,
  handed to it at `init`. One scheduler paints the rows and the Weather, News
  and Recent Imagery readouts once per frame, only where they are displayed,
  with one catch-up paint for what changed while hidden. Layers whose row reads
  the scene time declare `panelFollowsTime` instead of following the timeline.
  A layer that defines the old `setRowControlsListener` is refused, and data
  layers can no longer import the panel UI (samehkhamis, #1964).
