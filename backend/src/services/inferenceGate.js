const failure = (message, status) => Object.assign(new Error(message), { status });

/** Shared process-wide admission keeps local generation serial and the wait queue bounded. */
export class InferenceGate {
  constructor({ maxQueued = 8, queueTimeoutMs = 240000 } = {}) {
    if (
      !Number.isInteger(maxQueued) ||
      maxQueued < 0 ||
      maxQueued > 32 ||
      !Number.isFinite(queueTimeoutMs) ||
      queueTimeoutMs < 1 ||
      queueTimeoutMs > 240000
    )
      throw new Error('Invalid inference queue limits.');
    this.maxQueued = maxQueued;
    this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0;
    this.queue = [];
  }
  run(operation, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        start: () => {
          cleanup();
          this.active++;
          Promise.resolve()
            .then(() => {
              signal?.throwIfAborted();
              return operation();
            })
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.queue.shift()?.start();
            });
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const remove = (reason) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        cleanup();
        reject(reason);
      };
      const abort = () => remove(signal.reason);
      if (!this.active && !this.queue.length) return entry.start();
      if (this.queue.length >= this.maxQueued)
        return reject(
          failure(
            'Local inference is busy. The bounded queue is full; try again after the current request finishes.',
            429,
          ),
        );
      this.queue.push(entry);
      timer = setTimeout(
        () =>
          remove(
            failure('The local model queue timed out before this request started. Try again.', 503),
          ),
        this.queueTimeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  status() {
    return {
      active: this.active,
      queued: this.queue.length,
      maxActive: 1,
      maxQueued: this.maxQueued,
    };
  }
}
export const inferenceGate = new InferenceGate();
