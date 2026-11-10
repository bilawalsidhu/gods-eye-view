/** Cache dense, unchanged bracket pixels between position ticks. Never reduce resolution. */
export class DetectionBracketRaster {
  constructor(createCanvas = () => document.createElement('canvas')) {
    this.createCanvas = createCanvas;
    this.clear();
  }
  clear() {
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.ctx = null;
    this.cachedPaths = null;
    this.lastPaths = null;
    this.lastReuses = 0;
    this.unstable = 0;
    this.builds = 0;
    this.reuses = 0;
  }
  draw(ctx, cache, frame, lineWidth, alpha) {
    const width = Math.round(frame.width * frame.dpr),
      height = Math.round(frame.height * frame.dpr);
    const transform = ctx.getTransform?.();
    if (
      cache.count < 4096 ||
      width * height * 4 > 24 * 1024 * 1024 ||
      !width ||
      !height ||
      !transform ||
      transform.a !== frame.dpr ||
      transform.d !== frame.dpr ||
      transform.b !== 0 ||
      transform.c !== 0 ||
      transform.e !== 0 ||
      transform.f !== 0 ||
      (ctx.globalCompositeOperation &&
        ctx.globalCompositeOperation !== 'source-over')
    ) {
      this.clear();
      return false;
    }
    if (this.lastPaths !== cache.paths) {
      this.unstable = this.lastReuses ? 0 : this.unstable + 1;
      this.lastReuses = 0;
      this.lastPaths = cache.paths;
      if (this.unstable > 1) {
        if (this.canvas) {
          this.canvas.width = 0;
          this.canvas.height = 0;
          this.canvas = null;
          this.ctx = null;
          this.cachedPaths = null;
        }
        return false;
      }
    } else {
      this.lastReuses++;
      this.unstable = 0;
    }
    try {
      this.canvas ??= this.createCanvas();
      this.ctx ??= this.canvas.getContext('2d', {
        alpha: true,
        desynchronized: true,
      });
      if (!this.ctx) {
        this.clear();
        return false;
      }
      const resized =
        this.canvas.width !== width || this.canvas.height !== height;
      if (resized) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      if (
        resized ||
        this.cachedPaths !== cache.paths ||
        this.lineWidth !== lineWidth ||
        this.alpha !== alpha ||
        this.dpr !== frame.dpr
      ) {
        const paint = this.ctx;
        paint.setTransform(1, 0, 0, 1, 0, 0);
        paint.clearRect(0, 0, width, height);
        paint.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
        paint.lineWidth = lineWidth;
        for (const bands of cache.paths.values())
          for (const entry of bands)
            if (entry) {
              paint.globalAlpha = alpha * entry.alpha;
              paint.strokeStyle = entry.color;
              paint.stroke(entry.path);
            }
        this.cachedPaths = cache.paths;
        this.lineWidth = lineWidth;
        this.alpha = alpha;
        this.dpr = frame.dpr;
        this.builds++;
      } else this.reuses++;
      // Fade is already in the cached pixels: applying it after flattening
      // would change the alpha where brackets from different bands overlap.
      ctx.globalAlpha = 1;
      ctx.drawImage(this.canvas, 0, 0, width / frame.dpr, height / frame.dpr);
      return true;
    } catch {
      this.clear();
      return false;
    }
  }
  get bytes() {
    return (this.canvas?.width || 0) * (this.canvas?.height || 0) * 4;
  }
}
