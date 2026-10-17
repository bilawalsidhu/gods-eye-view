- Add a C-ITS (V2X) layer from OpenTrafficMap's volunteer receivers: traffic
  lights with their live signal phase painted onto MAPEM lanes, roadside
  units, warning trailers, DENM hazard corridors, buses and trams, drawn in
  Street Traffic's dot style. Trams carry detection brackets with line,
  destination and speed. Private vehicles appear only as anonymous dots, with
  no station address, card or track. Clicking a tram, bus, light or hazard
  opens one selected card on the globe. Chips in the layer row set how far
  vehicles, lights, labels and brackets stay visible, and a kind list with
  live counts picks what is shown. Keyless; share token `5`; attribution
  "OpenTrafficMap". The local `/api/cits` relay subscribes only the map tiles
  in view, rate-limits each client and closes when idle; the operator can opt
  into the full stream with `CITS_OTM_FULL_STREAM=1`, and
  `CITS_OTM_ENABLED=0` turns the relay off (@mupf-dev, #939).
