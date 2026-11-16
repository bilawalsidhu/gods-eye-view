- Draw the ISS as NASA's 3D model of the current station when the camera is
  near it, with parts that move by computation, not telemetry: solar arrays and
  radiators by the Sun, Ku-band dishes toward the relay satellites, robotic
  arms as an illustrative sway. Selecting the ISS opens NASA's official live
  video and a command panel with a zoom to the station, an Automatic mode and
  Manual controls for each moving part. The model draws through the renderer
  contract, whose model items gain `nodes` for a model's moving joints
  (Itallo Brandão, @IMBrandao, #1690).

- Let the ISS model's solar arrays, radiators and Ku-band dish take their real
  angles from NASA's public ISSLive telemetry. Off by default: set
  `ISS_TELEMETRY_ENABLED=1` and the server relays the feed over one connection,
  open only while the model is on screen; without signal the joints keep their
  computed rules (Denis Groshev, @ZloyS, #1690).
- Ride the ISS in the Cockpit from the station itself: views looking out from
  Nauka, Zarya, Poisk, the Cupola, Kibo and a docked vehicle, with the 3D
  model drawn, instead of the straight-down picture. It opens on Nauka, two arrows
  step through the rest, the readout describes the module each view is
  from (the Cupola and Kibo, which have no catalog entries, with cards of
  their own), and leaving selects Nauka (Denis Groshev, @ZloyS, #1690).
- Keep the ISS model centred, and offer its STATION and LIVE sections, when
  a click on the station's dot selects Nauka or a docked vehicle instead of the
  ISS entry; such an entry shows the ISS's orbit ring rather than a second ring
  of its own (Denis Groshev, @ZloyS, #1690).
- Move the ISS's command panel from a floating window into a STATION section
  of Context, shown while the station is selected on the map: Automatic says
  where the joints' angles come from (telemetry and how old it is, or
  computed values and why), Manual pauses telemetry and offers the Sun
  positions, array and radiator folding, dish aim and the Canadarm2 sliders.
  Another station plugs in with a description of its own
  (Denis Groshev, @ZloyS, #1690).
- Move the ISS's live video from a floating player into a LIVE section of
  Context: two NASA streams (exterior cameras; live video with space-to-ground
  audio), stepped with arrows, with an ON AIR dot while one plays and an
  offline card with Try again when the broadcast is off. The player loads,
  muted, as soon as the station is selected; the section's +/- hides it
  without stopping it. In the Cockpit the same stream is the briefing's
  fourth page, LIVE, which Previous, Next and the tabs reach and the
  automatic page cycle never turns to (Denis Groshev, @ZloyS, #1690).
- Draw China's Tiangong station as a 3D model up close, the second station
  after the ISS: an original model of the T configuration with a Shenzhou
  forward and nadir and a Tianzhou aft, its wings following the Sun, its
  antenna aimed at the Tianlian relay satellites and its two arms swaying for
  illustration (computed values; China publishes no telemetry). Selecting
  Tianhe, a lab or a docked ship gives the STATION section for Tiangong (Sun
  positions, each wing on its own slider, the two arms by joint); the model stands in for the docked
  entries' dots, and the Cockpit rides the station from views on the model
  (Tianhe, Wentian, Mengtian, the docked vehicle)
  (Denis Groshev, @ZloyS, #1690).
- Let a click on a mapped installation's label box count as a click on the
  site: it focuses the site in the orbital Cockpit view and selects it on the
  map, as a click on its 7 px dot did; from orbit the label is what a click
  lands on (Denis Groshev, @ZloyS, #1690).
