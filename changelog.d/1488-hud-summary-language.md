- Write the AI HUD summary in the interface language. The model now returns
  the feed state as its own field, and the HUD checks it against its own and
  adds its translated state tag, so a stale or partial view is never shown as
  live. A partial layer no longer reads as off or nominal in the HUD, voice
  and analyst provenance (German, @gekh, #1488).
