### Changed

- Playing the world clock away from live now draws at the display's own refresh rate instead of at most 60 FPS.
- Vessels following a playing clock are moved again once the fastest would have moved half a pixel on screen, at least once a second, and at once when the camera moves or zooms. Before, every drawn vessel moved every frame by a fraction of a pixel, which took most of each frame with thousands of vessels in view.
