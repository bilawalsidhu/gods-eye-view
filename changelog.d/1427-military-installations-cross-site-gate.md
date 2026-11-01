- The military-installations proxy (`/api/military-installations`) now refuses
  cross-site browser requests with the same `admitSameSite` gate that protects
  the terrain, CCTV, traffic, places, and Celestrak proxies. A cross-site
  `<img>`, a foreign `Origin`, an opaque origin, or a reverse-proxy-forwarded
  request receives 403 before any Overpass query runs. Same-origin app requests
  and bare tool requests (curl, Node harness) continue to work. (Sunil56224972)
