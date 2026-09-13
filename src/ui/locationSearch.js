import { createStateChannel } from '../app/stateChannel.js';

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
    this.state = {
      status: 'idle',
      searching: false,
      query: '',
      generation: null,
      requestId: 0,
      destination: null,
      error: null,
    };
    this.channel = createStateChannel(() => this.state);
  }
  getState() {
    return this.channel.getSnapshot();
  }
  subscribe(listener, options) {
    return this.channel.subscribe(listener, options);
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
    const change = (type) => ({
      type,
      generation: authority,
      requestId: generation,
      query,
    });
    this.state = {
      status: 'searching',
      searching: true,
      query,
      generation: authority,
      requestId: generation,
      destination: null,
      error: null,
    };
    try {
      this.onStart?.(authority);
      if (!current() || controller.signal.aborted) return;
      this.input.classList.add('searching');
      this.channel.publish(change('started'));
      if (!current() || controller.signal.aborted) return;
      const destination = await this.search(query, {
        signal: controller.signal,
        beforeFly: () => current() && this.beforeFly(authority),
      });
      if (!current() || controller.signal.aborted) return;
      if (destination?.cancelled) return;
      if (destination) {
        this.onResult?.(destination, query);
        if (!current() || controller.signal.aborted) return;
        this.state = {
          ...this.state,
          status: 'found',
          destination: { ...destination },
        };
        this.channel.publish(change('found'));
      } else {
        this.onMissing?.();
        if (!current() || controller.signal.aborted) return;
        this.state = { ...this.state, status: 'missing' };
        this.channel.publish(change('missing'));
      }
    } catch (error) {
      if (controller.signal.aborted || !current()) return;
      this.onError?.(error);
      if (!current() || controller.signal.aborted) return;
      this.state = {
        ...this.state,
        status: 'failed',
        error: { message: String(error?.message || error) },
      };
      this.channel.publish(change('failed'));
    } finally {
      if (this.controller === controller) this.controller = null;
      if (!this.destroyed) {
        if (generation === this.generation)
          this.state = {
            ...this.state,
            searching: false,
            status:
              this.state.status === 'searching'
                ? 'cancelled'
                : this.state.status,
          };
        this.onSettled?.(authority);
        this.channel.publish(change('settled'));
      }
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.state = { ...this.state, status: 'disposed', searching: false };
    this.channel.getSnapshot();
    this.channel.destroy();
  }
}
