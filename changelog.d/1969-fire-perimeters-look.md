- Fire Perimeters no longer blink out between timeline steps, and a step
  redraws only the newest fills and the edges of the fires that changed.
  Each fire draws as one bright orange area with a light amber edge over a
  dark halo, with no lines between its growth bands; from 80 km out it has
  a flame marker sized by its acres and a "name · acres" label, and the
  legend is one row, Burned area. Ground draw sets now stack by
  `drawOrder` too (German, @gekh, #1969).
