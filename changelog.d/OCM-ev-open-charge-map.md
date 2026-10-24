- EV Charging can add **Open Charge Map** detail with a free key in
  `OPEN_CHARGE_MAP_API_KEY` (POWER UP lists it). The key stays on the server:
  the browser reads `/api/ocm/poi`, which builds the only upstream URL from the
  view box, caches answers for ten minutes and keeps only records whose data
  provider is open-data licensed, never Mobie.pt (by agreement only) or
  Oplaadpalen.nl (CC BY-NC-SA). A site
  within 50 m of an OpenStreetMap station adds connectors, power, operator and
  reported status to its card; sites with no match appear in amber as Open
  Charge Map stations, credited to their provider. An Open Charge Map failure
  leaves the OpenStreetMap stations up, and without a key the layer is
  unchanged (daikaginza, #PR).
