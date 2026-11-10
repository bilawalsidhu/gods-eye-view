- Voice on OpenAI connects again: OpenAI Realtime refused every session, so
  the mic failed with "Failed to create Realtime token", because
  `resolve_area`'s area-id pattern uses Unicode classes it no longer accepts.
  Voice leaves those patterns out, as typed chat does; area ids are still
  checked before the tool runs (avaldini, #1638).
