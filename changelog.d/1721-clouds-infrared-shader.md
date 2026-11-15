- Satellite clouds on the 3D Tiles map apply their transparency in the shader
  instead of rewriting each 4096 x 2048 image on the page, and changing the
  cloud strength no longer builds a new image (mazy1998, #1721).
