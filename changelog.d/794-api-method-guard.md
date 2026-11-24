- Answer `405 Method Not Allowed` with `Allow: GET` to anything but `GET` on
  `/api/flights`, `/api/military` and `/api/route`, as the other query proxies
  do. They answered every verb with the same body. The refusal comes before
  rate limiting and any upstream call (daikaginza, #794).
