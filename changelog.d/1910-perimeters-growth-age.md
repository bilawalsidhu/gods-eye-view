- Color Fire Perimeters by how recently each area was mapped instead of by
  containment: each burned-area piece is yellow under 6 hours old, orange at
  6–24 hours, red at 1–3 days and dark red when older or of unknown age, with
  no line along the cuts between pieces. The legend counts fires by their last
  growth, the card adds "last growth … ago" and keeps containment, and
  `get_fire_perimeters` returns `last_growth`. A perimeter source now has one
  `getSnapshot` method, and `perimeterOptions: { inciweb: false }` turns off
  InciWeb links (gekh, #1910).
