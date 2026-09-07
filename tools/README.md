# Tools

The remaining utility is provider-neutral and works entirely on local files.
Generated output goes to `output/` by default (gitignored).

## `pano-pinhole.mjs`

Reproject an operator-supplied equirectangular panorama into perspective views.

```sh
node tools/pano-pinhole.mjs --input panorama.jpg --heading 270 --hfov 90
node tools/pano-pinhole.mjs --input panorama.jpg --all --step 45 --width 1920 --height 1080
```

Use `node tools/pano-pinhole.mjs --help` for all camera and output options.

For application screenshots, run the local app (`npm run dev`) and use the
browser QA harnesses. They render the current Azure Maps stack or its documented
OpenStreetMap fallback through the same BFF paths as production.
