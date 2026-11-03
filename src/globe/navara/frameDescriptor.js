// Navara auto-binds descriptor.update on creation but does not unregister
// that bound function when its handle is deleted. GEV's synchronous effects
// and meshes subscribe with their own callback so a parked view can be reused.
export function withFrameUpdates(Base) {
  return class extends Base {
    #frame = (time) => this.updateFrame(time);

    onCreate() {
      super.onCreate();
      this.view.on('preRender', this.#frame);
    }

    onDestroy() {
      this.view.off('preRender', this.#frame);
      super.onDestroy();
    }
  };
}
