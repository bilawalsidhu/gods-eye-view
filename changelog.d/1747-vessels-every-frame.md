- Move vessels every frame. Vessels between fixes, and live vessels a host
  placement places, were redrawn at most every 250 ms with a frame asked for
  once a second; they are now redrawn every frame, and the next frame is asked
  for once the fastest drawn vessel will have moved half a pixel on screen
  (Sameh Khamis, #1747).
