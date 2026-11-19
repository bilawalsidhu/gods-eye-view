- The Data Library and scene sharing dialogs are now one kit component,
  `UiDialog`. A scene sharing dialog the browser closes on its own now
  cancels through its owner, so the next share is not blocked, and a late
  close event no longer shuts a dialog opened again since (manjunath22466,
  samehkhamis, #1843).
