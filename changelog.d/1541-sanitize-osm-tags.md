- Flatten OSM-editable text before it reaches a model or an MCP tool result. A
  licence-plate-reader `operator` tag could carry newlines and a fake
  instruction into `find_alpr_cameras` rows, the Realtime model and the same
  tool over MCP; `cleanText()` capped length but kept the newlines, and analyst
  results copied names and operators with no cap at all. Those values are now
  flattened to one line and capped, with control characters replaced by spaces
  so neighbouring words do not fuse (mgkvibez, #1541).
