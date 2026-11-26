- Draw the ISS as NASA's 3D model of the current station when the camera is
  near it, its moving parts following computed rules: the solar arrays and
  radiators by the Sun, the Ku-band dishes toward the relay satellites, the
  robotic arms in an illustrative sway. The model draws through the renderer
  contract, whose model items gain `nodes` for a model's moving joints
  (Itallo Brandão, @IMBrandao; Denis Groshev, @ZloyS, #1767).
- Draw China's Tiangong station as a 3D model up close, the second station
  after the ISS: an original model of the T configuration with a Shenzhou
  forward and nadir and a Tianzhou aft, its wings following the Sun, its
  antenna aimed at the Tianlian relay satellites and its two arms swaying for
  illustration (computed values; China publishes no telemetry). The model
  stands in for the dots of the entries docked to it (Denis Groshev, @ZloyS,
  #1767).
- Add a STATION section to Context while a space station is selected on the
  map: Automatic says where the moving parts' angles come from, Manual offers
  Sun positions, array and radiator folding as a labelled demonstration, dish
  aim and the arms joint by joint, and Zoom brings the camera to the station.
  Selecting a module or a docked vehicle offers it as selecting the station
  does (Itallo Brandão, @IMBrandao; Denis Groshev, @ZloyS, #1767).
- Let the ISS model's solar arrays, radiators and Ku-band dish take their
  real angles from NASA's public ISSLive telemetry. Off by default: set
  `ISS_TELEMETRY_ENABLED=1` and the server relays the feed over one
  connection, open only while the model is on screen; without signal the
  joints keep their computed rules (Denis Groshev, @ZloyS; Kevin Rajan,
  @kvnloo, #1767).
- Add a LIVE section to Context while the ISS is selected: NASA's two live
  streams (exterior cameras; live video with space-to-ground audio), stepped
  with arrows, in YouTube's embedded player. Nothing loads until you press
  Play, under a line saying YouTube sees your IP address, and collapsing the
  section stops it. In the Cockpit the same stream is the briefing's fourth
  page, LIVE (Itallo Brandão, @IMBrandao; Denis Groshev, @ZloyS, #1767).
- Ride a space station in the Cockpit from views on its model instead of
  the straight-down picture: Nauka, Zarya, Poisk, the Cupola, Kibo and a
  docked vehicle on the ISS; Tianhe, Wentian, Mengtian and a docked vehicle
  on Tiangong. Two arrows step through them, the readout describes the module
  each view is from, and leaving selects the station (Denis Groshev, @ZloyS,
  #1767).
- Let a click on a mapped installation's label box select the site, as a
  click on its 7 px dot does: from orbit the label is what a click lands on.
  The label takes a click only where nothing else is drawn under it, so an
  aircraft or vessel under a base's label stays selectable (Denis Groshev,
  @ZloyS, #1767).
