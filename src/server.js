import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { createJob, getJob, publicJob, updateJob, cancelJob, startCleanupTimer } from './jobs.js';
import { ensureDirs, extractZip, saveUpload } from './files.js';
import { analyzeJob, processJob } from './pipeline.js';
import { runCommand } from './ffmpeg.js';

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const jobRoot = process.env.JOB_ROOT || '/tmp/voice-batch-jobs';
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const retentionMinutes = Number(process.env.JOB_RETENTION_MINUTES || 60);
const origins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());

await ensureDirs(jobRoot);
await app.register(cors, { origin: origins.includes('*') ? true : origins, credentials: false });
await app.register(multipart, { limits: { files: 1, fileSize: maxUploadBytes, fields: 20 } });
startCleanupTimer(retentionMinutes);

app.get('/health', async () => {
  const [ffmpeg, ffprobe] = await Promise.all([
    runCommand('ffmpeg', ['-version']).then(() => true).catch(() => false),
    runCommand('ffprobe', ['-version']).then(() => true).catch(() => false)
  ]);
  return { ok: ffmpeg && ffprobe, ffmpeg, ffprobe, service: 'voice-batch-studio-backend' };
});

async function receiveZip(request, job) {
  const part = await request.file();
  if (!part) throw app.httpErrors?.badRequest?.('ZIP file is required') || new Error('ZIP file is required');
  const original = sanitize(part.filename || 'upload.zip') || 'upload.zip';
  if (!original.toLowerCase().endsWith('.zip')) throw new Error('Only ZIP uploads are accepted');
  job.originalZipName = original;
  job.inputZip = path.join(job.workDir, 'input.zip');
  await saveUpload(part, job.inputZip, maxUploadBytes);
  updateJob(job, { status: 'extracting', stage: 'extracting', progress: 0 });
  const entries = await extractZip(job.inputZip, job.inputDir);
  job.totalFiles = entries.length;
  return entries;
}

function initializePaths(job) {
  job.workDir = path.join(jobRoot, job.id);
  job.inputDir = path.join(job.workDir, 'input');
  job.outputDir = path.join(job.workDir, 'output');
  job.outputZip = path.join(job.workDir, 'processed.zip');
  job.reportPath = path.join(job.workDir, 'audio_analysis_report.csv');
}

app.post('/analyze', async (request, reply) => {
  const job = createJob({ mode: 'analysis' });
  initializePaths(job);
  await ensureDirs(job.inputDir, job.outputDir);
  try {
    const entries = await receiveZip(request, job);
    void analyzeJob(job, entries).catch((error) => updateJob(job, { status: 'failed', stage: 'failed', error: error.message }, 'failed'));
    return reply.code(202).send({ jobId: job.id, job: publicJob(job) });
  } catch (error) {
    updateJob(job, { status: 'failed', stage: 'failed', error: error.message }, 'failed');
    return reply.code(400).send({ error: error.message, jobId: job.id });
  }
});

app.post('/jobs', async (request, reply) => {
  const job = createJob({ mode: 'analyze_and_process' });
  initializePaths(job);
  await ensureDirs(job.inputDir, job.outputDir);
  try {
    const entries = await receiveZip(request, job);
    const settings = parseSettings(request.query || {});
    void (async () => {
      await analyzeJob(job, entries, settings);
      await processJob(job, settings);
    })().catch((error) => updateJob(job, { status: error.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed', stage: 'failed', error: error.message }, 'failed'));
    return reply.code(202).send({ jobId: job.id, job: publicJob(job) });
  } catch (error) {
    updateJob(job, { status: 'failed', stage: 'failed', error: error.message }, 'failed');
    return reply.code(400).send({ error: error.message, jobId: job.id });
  }
});

app.post('/jobs/:id/process', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found or expired' });
  if (job.status !== 'analyzed') return reply.code(409).send({ error: `Job must be analyzed first; current status: ${job.status}` });
  const settings = parseSettings(request.body || {});
  void processJob(job, settings).catch((error) => updateJob(job, { status: error.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed', stage: 'failed', error: error.message }, 'failed'));
  return reply.code(202).send({ jobId: job.id, job: publicJob(job) });
});

app.get('/jobs/:id', async (request, reply) => {
  const job = getJob(request.params.id);
  return job ? publicJob(job) : reply.code(404).send({ error: 'Job not found or expired' });
});

app.get('/jobs/:id/events', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found or expired' });
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = ({ event = 'message', data }) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send({ event: 'snapshot', data: publicJob(job) });
  const listener = (message) => send(message);
  job.emitter.on('message', listener);
  const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15_000);
  const cleanup = () => { clearInterval(heartbeat); job.emitter.off('message', listener); if (!res.writableEnded) res.end(); };
  request.raw.once('close', cleanup);
  request.raw.once('error', cleanup);
});

app.get('/jobs/:id/download', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job || job.status !== 'completed') return reply.code(404).send({ error: 'Processed ZIP is not ready' });
  const name = `${path.parse(job.originalZipName || 'audio').name}_normalized.zip`;
  reply.header('Content-Disposition', `attachment; filename="${sanitize(name)}"`).type('application/zip');
  return reply.send(fs.createReadStream(job.outputZip));
});

app.get('/jobs/:id/report.csv', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job || !await exists(job.reportPath)) return reply.code(404).send({ error: 'Report is not ready' });
  reply.header('Content-Disposition', 'attachment; filename="audio_analysis_report.csv"').type('text/csv; charset=utf-8');
  return reply.send(fs.createReadStream(job.reportPath));
});

app.post('/jobs/:id/cancel', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found or expired' });
  cancelJob(job);
  return { ok: true, job: publicJob(job) };
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
});

function parseSettings(input) {
  return {
    targetLufs: Number(input.targetLufs ?? -16), lra: Number(input.lra ?? 7), truePeak: Number(input.truePeak ?? -1.5),
    speed: Number(input.speed ?? 1), preset: String(input.preset ?? 'original'), bitrateKbps: Number(input.bitrateKbps ?? 192),
    toleranceLu: Number(input.toleranceLu ?? 0.5)
  };
}

async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }

await app.listen({ port, host });
