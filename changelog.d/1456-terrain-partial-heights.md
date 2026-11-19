- A terrain request the proxy can only partly answer (a 429 pause, or a point
  the upstream returns without a height) now keeps the real heights it has
  instead of putting the whole chunk on the geoid (quanticsoul4772, #1456).
