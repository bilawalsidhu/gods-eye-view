- Scenes keep the "Scene not saved" status when a capture, update, append or
  import cannot be saved, and an unreadable saved project no longer overwrites
  the recovery checkpoint. `startScene()` resolves to its documented result,
  `afterShotId` works without an explicit scene, and `scenesRun` counts the
  distinct scenes queued (djabhi31, #1135).
