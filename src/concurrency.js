import os from "node:os";

function positiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function detectedCpuCount() {
  return positiveInt(process.env.CPU_COUNT) ?? Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1);
}

export function configuredWorkerCount() {
  const override = positiveInt(process.env.FFMPEG_WORKERS ?? process.env.WORKER_COUNT);
  if (override) return Math.min(override, 64);
  return Math.min(Math.max(2, detectedCpuCount() * 2), 64);
}

export const FFMPEG_WORKERS = configuredWorkerCount();

class AsyncLimiter {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.activeCount = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeCount++;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeCount--;
          this.#drain();
        });
    }
  }
}

// Global limit protects the whole Railway process when multiple jobs overlap.
export const ffmpegFileLimit = new AsyncLimiter(FFMPEG_WORKERS);
