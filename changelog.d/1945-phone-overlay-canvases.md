- Phones and tablets without a mouse, trackpad or pen draw the overlay canvases
  and the scope mask at CSS pixels instead of the full device pixel ratio, and
  the hidden detection surface holds no memory until a detection layer draws,
  cutting the opening globe's canvas memory on a phone by over 100 MB (#1945).
