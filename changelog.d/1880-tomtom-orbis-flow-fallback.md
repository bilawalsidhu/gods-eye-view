- Live traffic works with TomTom keys that are only assigned the Orbis Maps
  traffic product: when TomTom refuses the key on the TomTom Maps flow tile
  endpoint (HTTP 403), the proxy uses the Orbis one and keeps it. A key both
  endpoints refuse now reads "TomTom key rejected" instead of "TomTom upstream
  unreachable", and stops spending the daily tile budget on retries (#1809).
