- Let the scene idle with AIS vessels enabled. Vessels no longer hold the
  continuous render loop; they request frames for new data and selection, one
  trailing frame after the camera stops, and hold the loop only while focus
  emphasis animates or a vessel stays dimmed under a tracked target. A parked
  vessels-only scene went from continuous rendering to 0 frames in 5 s. While
  anything is tracked, the vessel focus pass skips hidden sprites at rest:
  about 4 ms to 1.2 ms per pass over 12,000 vessels (waar19, #871).
