- Stop the browser caching a refused Google Places or Geocoding answer. The
  proxies sent `private, max-age=300` on a 403 and on a geocode
  `REQUEST_DENIED` or `OVER_QUERY_LIMIT`, so a fixed key kept failing for five
  minutes; refusals are now `no-store` (Rudy Celekli, @rudycelekli, #1570).
