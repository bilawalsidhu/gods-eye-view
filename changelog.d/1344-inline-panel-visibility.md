- Pause the HUD's camera readout while the page is hidden, as polled layers
  already do. An app embedded inline in a panel keeps both updating, because the
  panel's host can report the page as hidden while it is on screen (nu-stats,
  #1344).
