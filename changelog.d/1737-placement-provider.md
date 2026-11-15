- Let a host application decide where live contacts are drawn.
  `createApplicationCatalog({ placement })` takes a placement provider whose
  `layer(kind)` hands Flights, Military Flights, AIS Vessels, Transit and Rail
  a `place(id, wallMs)` (and optionally `observe(id, fix)`, `forget(id)`):
  each layer tells it every live fix it accepts and draws a contact where it
  places it. Without one, or for a contact it does not place, every layer
  moves as before (samehkhamis, #1737).
