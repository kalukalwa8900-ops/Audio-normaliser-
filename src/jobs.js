import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";

export const WORK_ROOT = process.env.WORK_ROOT ?? path.join(process.cwd(), "work");

export const jobs = new Map();

export function createJob({ id, dir, inDir, outDir, settings, files, fileMap }) {
  const job = new EventEmitter();
  job.id = id;
  job.dir = dir;
  job.inDir = inDir;
  job.outDir = outDir;
  job.settings = settings ?? {};
  job.files = files;           // [{ id, name, folder, sequence, overrides, excluded }]
  job.fileMap = fileMap;       // Map(id -> local input path)
  job.progress = {
    stage: "uploading",
    overallPct: 0,
    completed: 0,
    failed: 0,
    total: files.filter((f) => !f.excluded).length,
  };
  job.fileResults = [];        // [{ id, result }]
  job.cancelled = false;
  job.done = false;
  job.retention = settings?.retention ?? "1h";
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}
