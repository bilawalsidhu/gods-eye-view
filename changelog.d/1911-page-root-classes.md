- Stop restyling the whole page on every DOM change. Rules that checked
  `body:has(...)` now read classes on the page root that the components owning
  that state set, and the Intel HUD runs no timers and writes nothing while it
  is not displayed (samehkhamis, #1911).
