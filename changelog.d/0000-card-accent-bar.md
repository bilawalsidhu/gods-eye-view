- Detail and selected cards on the globe, and annotation callouts, no longer
  carry a coloured bar down their left edge; an annotation callout is outlined
  in its mark's colour instead. The selected and tracked cards are now drawn by
  a Vue component (`WorldOverlayCards`) at the place the overlay solves for
  them; the overlay still paints their leader lines. `?overlayCards=all` draws
  the ambient detail cards the same way and `?overlayCards=off` returns every
  card to the canvas (mazy1998).
