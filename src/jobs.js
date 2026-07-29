import { EventEmitter } from "node:events";
import path from "node:path";

export const WORK_ROOT = process.env.WORK_ROOT ?? path.join(process.cwd(), "work");
export const jobs = new Map();

export function createJob({ id, dir, inDir, outDir, settings, files, fileMap }) {
  const job = new EventEmitter();
  job.setMaxListeners(100);
  job.id = id;
  job.dir = dir;
  job.inDir = inDir;
  job.outDir = outDir;
  job.settings = settings ?? {};
  job.files = files;
  job.fileMap = fileMap;
  job.status = "queued";
  job.success = false;
  job.error = null;
  job.progress = {
    stage: "queued",
    overallPct: 0,
    completed: 0,
    failed: 0,
    total: files.filter((file) => !file.excluded).length,
  };
  job.fileResults = [];
  job.cancelled = false;
  job.done = false;
  job.abortController = new AbortController();
  job.retention = settings?.retention ?? "1h";
  job.cleanupTimer = null;
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function finishJob(job, { status, success, error = null }) {
  if (job.done) return;
  job.status = status;
  job.success = success;
  job.error = error;
  job.done = true;
  job.emit("done", {
    jobId: job.id,
    status,
    success,
    error,
  });
}
