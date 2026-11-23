- Add an opt-in **Local AIS** layer for vessels heard on your own AIS-catcher
  receiver. The server reads `ships.json` from `LOCAL_AIS_FEEDS` (local or
  private hosts only, no AISStream key). The layer row says when a receiver is
  silent or unreachable instead of reading live, keeps unknown values unknown
  and flags positions the receiver has not validated yet. AIS-SART, man-overboard
  and EPIRB beacons are drawn with their own marker and card as a distress or
  test beacon your receiver heard, never as a vessel and never as a verified
  emergency (the caveat is on the Context card). For voice, the text tools do not hand an unvalidated or
  approximate fix to the hosted model as coordinates, but flagged vessels are
  still drawn on the map, so screenshots, the pointer's screen position, a
  cursor next to the marker, the view's camera position and
  `get_entity_context`'s camera, view-centre point and nearby list, if you
  centre a flagged vessel, can still locate them (theerayutbo, #1878).
