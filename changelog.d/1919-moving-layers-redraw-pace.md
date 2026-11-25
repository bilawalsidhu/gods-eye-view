- Moving layers no longer hold the globe at the display's refresh rate.
  Satellites, flights, military flights and vessels draw as often as their
  fastest mark in view moves on screen, about half a pixel a draw: never
  fewer than 3 draws a second, never more than 30. Following a contact draws
  at 30; steering the camera still draws at the display's rate. On a still
  camera the whole globe with flights went from 132 to 10 draws a second, and
  with satellites from 162 to 6. Placed flights replan spread over time (far
  or off-screen ones about every 4 s), a new report that moves one eases it
  there instead of jumping, and a tracked aircraft's trail head ends where it
  is drawn in that frame (samehkhamis, #1919).
