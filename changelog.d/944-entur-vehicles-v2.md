- Show Norway's whole live transit fleet. The Entur feed now reads the
  Vehicles GraphQL API (realtime v2) instead of the v1 GTFS-Realtime feed,
  which lacks Skyss, Vestfold og Telemark, Innlandet and other operators —
  roughly half again as many vehicles. Each vehicle's own reported mode (bus,
  coach, tram, rail, ferry) sets its marker. Three coverage circles now reach
  from Lindesnes to Vardø and Grense Jakobselv, while Sweden, Finland,
  Murmansk, the Faroes and Shetland stay out of range. Above 400 km a feed is
  also polled when one of its circles reaches into a map-like view, so a
  whole-country view centred over Sweden still shows Norway. Ruter does not publish
  to either open Entur feed (trygvehhh, #944).
