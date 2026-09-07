export class ReadinessState {
  #ready = false;
  #reason = 'starting';

  markReady(): void {
    this.#ready = true;
    this.#reason = 'ready';
  }

  markNotReady(reason: string): void {
    this.#ready = false;
    this.#reason = reason;
  }

  snapshot(): Readonly<{ ready: boolean; reason: string }> {
    return { ready: this.#ready, reason: this.#reason };
  }
}
