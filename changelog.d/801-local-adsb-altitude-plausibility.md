- Local ADS-B no longer draws an aircraft at an altitude it cannot have
  reached. A corrupt frame can still pass CRC, and one reached the globe as a
  DC-9 at 108,800 ft. Each altitude report must now be reachable from the last
  accepted one at a plausible vertical rate, whether it came from the browser
  SDR or a decoder feed. A refused report keeps the previous altitude for the
  marker, the card and the 3D model alike, and the held record is marked
  `altitudeQuality: 'held-after-rejection'`. Only a newly heard altitude is
  judged, so later non-altitude messages cannot count one bad frame three
  times. Three refusals in a row start over from the new value, and a surface
  report is never compared with the last airborne altitude. The layer stats
  count refusals as `rejectedAltitudes` (Pedro Lobato, #801).
