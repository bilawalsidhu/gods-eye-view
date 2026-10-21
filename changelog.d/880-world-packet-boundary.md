- Extract a reusable model-free World Packet from the existing voice
  `get_current_view_state` owner without restoring disabled layers to the
  model context. Keep the enabled-only payload, disabled-layer count, source
  provenance, action result and view-state contract; read the layer roster once
  per packet; voice retains the speech/card envelope at its own boundary.
  Credits: original GEV voice/layer contributors and #880 implementation.
