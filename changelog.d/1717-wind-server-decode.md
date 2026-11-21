- The Wind server no longer blocks every other request while it decodes a
  forecast. Decoding runs on a worker thread (up to 400 ms of blocking down to
  about 4 ms), and choosing an overlay after wind has loaded fetches only the
  overlay's field (mazy1998, #1717).
