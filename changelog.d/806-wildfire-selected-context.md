- Explicit wildfire-perimeter picks keep only the active incident in shared
  context. Switching incidents evicts the prior record; ordinary refreshes do
  not re-announce a click (kvnloo, #797, #806; review: quanticsoul4772).

Foreground overlay cards take precedence over perimeter ground picks in either click-listener order. Deliberate deselection and switching preserve shared-context event semantics; true feed eviction remains distinct.
