- The live flight snapshot is compressed on the wire. `/api/flights` gzips its
  cached global snapshot and its regional adsb.lol fallback once per upstream
  refresh and serves that frame to clients offering gzip — roughly 860 KB
  becomes roughly 258 KB — while a client that offers nothing receives the same
  bytes uncompressed. Both answers carry `Vary: Accept-Encoding`, and a response
  the proxy does not cache, such as an auth failure, is never sent under a
  cached snapshot's encoding (daikaginza, #795).
