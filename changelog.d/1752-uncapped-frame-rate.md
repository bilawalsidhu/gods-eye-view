### Changed

- While anything moves (layers in motion, the camera, a followed contact), the globe now draws at the display's own refresh rate instead of a fixed 60 frames a second. A parked scene still ticks at most 60 times a second. Waits that counted frames (a followed contact's first position, a shared follow view, a trail's temporary copy) now count drawn time, so they last the same at any refresh rate. Screen marks over a followed contact fade out over the same time at any refresh rate.
