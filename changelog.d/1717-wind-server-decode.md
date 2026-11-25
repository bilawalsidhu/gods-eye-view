- The Wind server no longer blocks every other request while it decodes a
  forecast. Decoding runs on a worker thread. A refresh used to block the
  server for 40 to 160 ms, and up to about 1 s when every feed refreshed at
  once. Now it blocks for a few milliseconds. Choosing an overlay after wind
  has loaded fetches only the forecast index and the overlay's field while
  the forecast file is the same (mazy1998, #1717).
