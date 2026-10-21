- Alpine Stations: about 650 automatic weather stations across the Swiss and
  Austrian Alps, drawn as markers coloured by a chosen measurement, with the
  readings, a legend and the nearest stations in view in a WEATHER rail card.
  Three keyless CC BY 4.0 networks, one adapter each (WSL/SLF IMIS,
  MeteoSwiss SwissMetNet, GeoSphere Austria TAWES), relayed through a bounded
  same-origin `/api/alpine-stations`. One network being unavailable never
  blanks the others. Per-network capability is explicit, so a network that
  cannot supply a measurement honestly does not claim it: SwissMetNet
  contributes no snow depth and GeoSphere no sea-level pressure. Replaces #58
  (darrendignam, #1311).
