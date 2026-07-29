import os from "node:os";
import { promises as fs } from "node:fs";

function positiveInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function cgroupCpuCount() {
  try {
    const cpuMax = (await fs.readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim();
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
    if (quotaRaw !== "max") {
      const quota = Number(quotaRaw);
      const period = Number(periodRaw);
      if (quota > 0 && period > 0) return Math.max(1, Math.ceil(quota / period));
    }
  } catch {
    // cgroup v2 is not available.
  }
  try {
    const [quotaRaw, periodRaw] = await Promise.all([
      fs.readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8"),
      fs.readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8"),
    ]);
    const quota = Number(quotaRaw.trim());
    const period = Number(periodRaw.trim());
    if (quota > 0 && period > 0) return Math.max(1, Math.ceil(quota / period));
  } catch {
    // cgroup v1 is not available.
  }
  return null;
}

export async function detectedCpuCount() {
  const override = positiveInt(process.env.CPU_COUNT);
  if (override) return override;
  const cgroup = await cgroupCpuCount();
  const host = Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1);
  return cgroup ? Math.min(cgroup, host) : host;
}

export async function configuredWorkerCount() {
  const override = positiveInt(process.env.FFMPEG_WORKERS ?? process.env.WORKER_COUNT);
  if (override) return Math.min(override, 64);
  const cpuCount = await detectedCpuCount();
  return Math.min(Math.max(2, cpuCount * 2), 64);
}

export class AsyncLimiter {
  constructor(concurrency) {
    this.concurrency = Math.max(1, concurrency);
    this.activeCount = 0;
    this.queue = [];
  }

  run(task, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error("operation cancelled before it started");
        error.name = "AbortError";
        reject(error);
        return;
      }
      const item = { task, resolve, reject, signal, onAbort: null };
      if (signal) {
        item.onAbort = () => {
          const index = this.queue.indexOf(item);
          if (index >= 0) {
            this.queue.splice(index, 1);
            const error = new Error("operation cancelled before it started");
            error.name = "AbortError";
            reject(error);
          }
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      this.queue.push(item);
      this.#drain();
    });
  }

  #drain() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      item.signal?.removeEventListener("abort", item.onAbort);
      if (item.signal?.aborted) {
        const error = new Error("operation cancelled before it started");
        error.name = "AbortError";
        item.reject(error);
        continue;
      }
      this.activeCount += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.#drain();
        });
    }
  }
}

export async function createFfmpegLimiter() {
  const workerCount = await configuredWorkerCount();
  return { workerCount, limiter: new AsyncLimiter(workerCount) };
}
