- A weather feed that supplies its own tiles can name how deep they go for
  each product (`frameMaximumLevel`). Global satellite clouds are then drawn
  from those tiles to that level instead of from one 2048 × 1024 image, so
  they stay sharp when zoomed in; radar and the other tiled products take the
  named level too. Without it, clouds keep the single image and level 3.
