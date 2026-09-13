/** One cancellable place lookup at a time, under the caller's camera authority. */
export class LocationSearch {
  constructor({
    input,
    begin,
    isCurrent,
    beforeFly,
    search,
    onStart,
    onResult,
    onMissing,
    onError,
    onSettled,
  }) {
    Object.assign(this, {
      input,
      begin,
      isCurrent,
      beforeFly,
      search,
      onStart,
      onResult,
      onMissing,
      onError,
      onSettled,
    });
    this.controller = null;
    this.generation = 0;
    this.destroyed = false;
  }
  async run(query) {
    query = String(query || '').trim();
    if (!query || this.destroyed) return;
    const authority = this.begin();
    if (authority === false) {
      this.input.classList.remove('searching');
      this.input.blur();
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const current = () =>
      !this.destroyed &&
      generation === this.generation &&
      this.isCurrent(authority);
    this.onStart(authority);
    this.input.classList.add('searching');
    try {
      const destination = await this.search(query, {
        signal: controller.signal,
        beforeFly: () => current() && this.beforeFly(authority),
      });
      if (!current() || controller.signal.aborted) return;
      if (destination?.cancelled) return;
      if (destination) this.onResult(destination, query);
      else this.onMissing();
    } catch (error) {
      if (controller.signal.aborted || !current()) return;
      this.onError(error);
    } finally {
      if (this.controller === controller) this.controller = null;
      if (!this.destroyed) this.onSettled(authority);
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
}
