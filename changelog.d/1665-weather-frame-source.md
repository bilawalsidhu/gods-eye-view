- A weather feed can supply decoded frames to the weather layers. With an
  optional `getFrameImage` or `getFrameTile`, Core draws the images and tiles
  the feed returns instead of reading the image and tile routes; a feed
  without them is unchanged (samehkhamis, #1665).
