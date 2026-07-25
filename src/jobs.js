import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const jobs = new Map();

export function createJob(base = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'created',
    stage: 'created',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    cancelled: false,
    files: [],
    errors: [],
    emitter: new EventEmitter(),
    ...base
  };
  job.emitter.setMaxListeners(100);
  jobs.set(id, job);
  return job;
}

export function getJob(id) { return jobs.get(id); }

export function publicJob(job) {
  if (!job) return null;
  const { emitter, inputDir, outputDir, workDir, inputZip, outputZip, reportPath, ...safe } = job;
  return safe;
}

export function updateJob(job, patch, event = 'progress') {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const payload = publicJob(job);
  job.emitter.emit(event, payload);
  job.emitter.emit('message', { event, data: payload });
  return job;
}

export function cancelJob(job) {
  job.cancelled = true;
  updateJob(job, { status: 'cancelling', stage: 'cancelling' }, 'cancelled');
}

export function assertNotCancelled(job) {
  if (job.cancelled) {
    const error = new Error('Job cancelled by user');
    error.code = 'JOB_CANCELLED';
    throw error;
  }
}

export function startCleanupTimer(retentionMinutes = 60) {
  const interval = Math.max(60_000, Math.min(retentionMinutes * 60_000, 15 * 60_000));
  const timer = setInterval(async () => {
    const cutoff = Date.now() - retentionMinutes * 60_000;
    for (const [id, job] of jobs.entries()) {
      const updated = Date.parse(job.updatedAt || job.createdAt);
      if (updated < cutoff && ['completed', 'failed', 'cancelled'].includes(job.status)) {
        jobs.delete(id);
        if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, interval);
  timer.unref();
}
