- Compress the live flight snapshot on the wire. `/api/flights` gzips its
  cached global snapshot and its regional adsb.lol fallback once per refresh
  and sends that frame to clients that offer gzip: about 860 KB becomes about
  250 KB. Other clients get the same bytes uncompressed, and both answers carry
  `Vary: Accept-Encoding` (daikaginza, #795).
