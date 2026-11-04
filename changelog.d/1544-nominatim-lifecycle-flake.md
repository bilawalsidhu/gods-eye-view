- Fix an intermittent failure in the Nominatim restart test: it waited a fixed
  50 ms for the saved daily count to load, which a busy machine overran. It now
  waits for the count itself (stuart170180, #1544).
