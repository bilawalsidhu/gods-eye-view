- The voice debug log now says why OpenAI Realtime did or did not get a
  viewport screenshot or pointer crop. Each entity-context answer logs a
  reason-coded decision and, when an image was due, one outcome under the same
  id, so a crop that was dropped because the pointer went stale or the camera
  moved is no longer counted as sent. What is captured, sent and kept is
  unchanged, and no image data or user text is logged (kvnloo, manjunath22466,
  #835).
