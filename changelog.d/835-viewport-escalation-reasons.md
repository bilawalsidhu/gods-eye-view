- The voice debug log now says why OpenAI Realtime did or did not get a
  viewport screenshot or pointer crop. When an entity-context answer reaches
  the image step, the log records a reason-coded decision and, when an image
  was due, one outcome under the same id: sent, or why it was dropped (a stale
  pointer, a camera move, a newer turn). What is captured, sent and kept is
  unchanged, and no image data or user text is logged (Kevin Rajan, @kvnloo,
  Manjunath, @manjunath22466, #835).
