- Timeline marks have labels. Hovering a tick shows its label (a launch's
  mission name, or an earthquake's magnitude and place, such as
  `M6.4 · 113 km SSE of Lata, Solomon Islands`), and a tap on or within 6 px
  of a tick goes exactly to its mark rather than to the point tapped; a tap
  elsewhere and a drag work as before. The arrow keys still step from mark to
  mark, and the handle then tells the mark's label with the time to screen
  readers and shows it over the track while focused. A layer's world clock
  coverage may give each mark as `{ time, label, id, kind }` as well as a
  bare time. `worldClock.coverage()` keeps `marks` as the sorted times and
  adds `markDetails`, the merged marks themselves, merged on their whole
  label; a label longer than `WORLD_CLOCK_MARK_LABEL_LENGTH` (60 characters,
  exported from `gods-eye-view/time`) is then cut, ending in `…`, never
  splitting an emoji. A zoom or a pan clears the hovered label, and a label
  is never wider than the track (samehkhamis, #1745).
- The timeline marks only events: launches, and earthquakes of magnitude 6
  and up while the Earthquakes layer is on (about one every two days
  worldwide). It no longer draws a tick for every weather frame, which came
  every few minutes and made the track a wall of dashes; the weather frames
  still set the time the timeline covers, and Play still waits at each next
  frame until it loads. With no mark ahead, the arrow keys step along the
  track. The map still draws every earthquake, and an earthquake layer never
  widens the timeline beyond its strong quakes' own times. The Earthquakes
  layer registers with the world clock (`gods-eye-view/time`) once it is
  initialised, and has time to show only while on;
  `gods-eye-view/layers/earthquakes` adds `EARTHQUAKE_MARK_MAGNITUDE`,
  `earthquakeMagnitudeTitle`, `earthquakeMarkLabel` and `earthquakeCoverage`.
  A weather row's `step` param goes to the previous or next weather frame
  (samehkhamis, #1745).
- The main timeline is the only time control. The Weather panel no longer
  has a slider, step buttons, Latest or Play of its own; it shows the frame
  time instead: the newest frame and its age while live, the timeline time
  alone at a past time; while live it shows the newest frame even when the
  products are suspended (reduced motion, a hidden page, no imagery host).
  The timeline's Play runs the world clock at the chosen speed for weather
  too, stopping at each next frame until it loads, rather than stepping the
  observed frames every two seconds and going round from the last to the
  first. A weather row's `play` and `latest` params move the world clock as
  the timeline does: `play` runs at the timeline's chosen speed, from the
  start when live or at the end, and does nothing while every product the
  row shows is suspended or while there is no time to show. The world clock
  keeps a chosen rate while paused and live (`goLive()` no longer sets it
  back to 1), so any play runs at it, and the timeline's speed shows the
  clock's rate whoever set it (the nearest offered speed for another rate).
  A weather layer made without a weather clock leaves the world clock alone
  until it is first enabled, does nothing once destroyed, and destroying it
  leaves the world clock's time where it is. **Breaking:** the catalog's
  `weatherClock` (`gods-eye-view/application/layers`) no longer has
  `setTarget`, `step`, `latest`, `play`, `pause` or `togglePlay`, its state
  no longer has `playing`, and it no longer attaches itself to the world
  clock as a driver; move time with the world clock (`gods-eye-view/time`,
  also `weatherClock.world`) instead (samehkhamis, #1745).
