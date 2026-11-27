- Let a camera source give each frame's time: a source that sets
  `framesCarryTime: true` answers its frame URLs with the capture time in
  epoch milliseconds in an `X-CCTV-Frame-Time` header, and the CCTV panel, the
  camera's card and its bigger view show that time with the picture. A frame
  without the header shows no time, and other sources load frames as before
  (samehkhamis, #1956).
