import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pausedRoute } from '../../testSupport/pausedRoute.mjs';

test('reduced motion: tiles arriving after the route still are drawn', async () => {
  const { preview, widget } = await pausedRoute({ tilesLoaded: false });
  const before = widget.renders;
  // The imagery tiles finish loading after the still frame.
  widget.scene.globe.tilesLoaded = true;
  widget.scene.globe.tileLoadProgressEvent.raiseEvent(0);
  for (let i = 0; i < 5; i++) widget.tick();
  assert.ok(
    widget.renders > before,
    `no frame drawn after the tiles arrived (renders ${before} -> ${widget.renders})`,
  );
  preview.destroy();
});

test('once its tiles are in, a paused route stops rendering', async () => {
  const { preview, widget } = await pausedRoute({ tilesLoaded: false });
  assert.equal(widget.useDefaultRenderLoop, true);
  widget.scene.globe.tilesLoaded = true;
  widget.tick();
  assert.equal(widget.useDefaultRenderLoop, false);
  const before = widget.renders;
  widget.tick();
  assert.equal(widget.renders, before);
  preview.destroy();
});
