- Restore a shot's declared layer visibility when seeking within it after manual
  layer changes, including toggles still in flight. Only changed layers are
  reconciled; refused restoration reports a failed seek and keeps the last
  position, while undeclared operator layers are preserved (@oneill9, #1374).
