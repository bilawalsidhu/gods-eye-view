- The military-installations proxy (`/api/military-installations`) now refuses
  cross-site and reverse-proxy-forwarded browser requests with 403 before any
  Overpass work, through the same shared gate as `/api/overpass`. Same-origin
  app requests and local tools such as curl still work (@Sunil56224972, #1427).
