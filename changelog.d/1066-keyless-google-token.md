- Keyless standalone startup answers an unavailable Google tile-token endpoint
  with uncached 204 instead of a browser-visible 404. Existing providers take
  precedence, and unrelated API routes behave as before. (dvilrgamerz, #1066)
