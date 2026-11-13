- Add a Google Earth-style navigation control at the bottom right: a compass
  ring that shows and drags the heading (arrow keys turn it, Home returns to
  north), north up, a tilt slider with up/down and top-down buttons, zoom with
  press-and-hold repeat, and a look-around pad. It orbits the point under the
  centre of the view through the navigation policy, so it declines in the
  Cockpit and releases a followed aircraft first (Byrd-IT, #1312).
- Stop a compass drag when the navigation policy refuses a move, for
  example when the Cockpit takes the camera mid-drag; only a new press
  starts another drag (Byrd-IT, #1312; thanks @kvnloo for the review).
