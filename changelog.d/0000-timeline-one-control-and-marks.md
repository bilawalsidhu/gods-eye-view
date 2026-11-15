- The timeline marks only events: launches, and earthquakes of magnitude 6
  and up while the Earthquakes layer is on (about one every two days
  worldwide). It no longer draws a tick for every weather frame, which came
  every few minutes and made the track a wall of dashes; the weather frames
  still set the time the timeline covers, and Play still waits at each next
  frame until it loads. With no mark ahead, the arrow keys step along the
  track. The map still draws every earthquake, and an earthquake layer never
  widens the timeline beyond its strong quakes' own times. A weather row's
  `step` param goes to the previous or next weather frame (samehkhamis,
  #0000).
- The main timeline is the only time control. The Weather panel no longer
  has a slider, step buttons, Latest or Play of its own; it shows the frame
  time instead: the newest frame and its age while live, the timeline time
  alone at a past time. The timeline's Play runs the world clock at the
  chosen speed for weather too, stopping at each next frame until it loads,
  rather than stepping the observed frames every two seconds and going round
  from the last to the first. A weather row's `play`, `latest` and `step`
  params move the world clock as the timeline does (`step` goes to the
  previous or next mark, as its arrow keys do). **Breaking:** the catalog's
  `weatherClock` (`gods-eye-view/application/layers`) no longer has
  `setTarget`, `step`, `latest`, `play`, `pause` or `togglePlay`, its state
  no longer has `playing`, and it no longer attaches itself to the world
  clock as a driver; move time with the world clock (`gods-eye-view/time`,
  also `weatherClock.world`) instead (samehkhamis, #0000).
