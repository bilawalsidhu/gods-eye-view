- `F` now collapses and reopens the Data Layers panel the way the panel's own
  button does, and its rail entry stays. Before, `F` hid the panel together
  with its rail entry, so only another `F` brought it back. When `F` or a
  panel's collapse button hides a panel that holds the focus, including one
  the opened panel folds away, the focus moves to that panel's rail entry;
  in Cockpit, focus in the Contact card it folds moves to the card's expand
  button (asturksever, #1598).
