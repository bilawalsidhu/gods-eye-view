- The detection overlay no longer rebuilds its brackets on a paint where the
  view and every contact are unchanged; a label solve (up to 8 a second)
  still rebuilds them. This saves work only when the globe repaints more
  often than its contacts move: at a still camera over Live Flights some
  aircraft move before almost every paint, so nearly every paint is still a
  full rebuild (mazy1998, #1719).
