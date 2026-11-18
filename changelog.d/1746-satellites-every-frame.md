- Move satellites every frame. Points were propagated once a second and held
  still in between, so at 1 min/s they jumped about 45 px a second; each now
  glides from its last SGP4 sample (position, velocity, gravity and its rate
  of change) to the world time, resampled every second and whenever time
  moves 30 s from it, within about 10 m of SGP4 (Sameh Khamis, #1746).
