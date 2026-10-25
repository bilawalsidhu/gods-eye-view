- Keep a tracked vessel's speed, course, heading and fix time when AISStream
  static data arrives; the static message only merges name, type, destination
  and IMO (rudycelekli, #1351).
- Apply changed static metadata immediately, retaining known fields when a
  later static report omits them, without refreshing the vessel's position
  (samehkhamis, #1351).
