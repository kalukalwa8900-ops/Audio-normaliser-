import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { nanoid } from "nanoid";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, finishJob, getJob, jobs, WORK_ROOT } from "./jobs.js";
import { analyzeMp3, ffmpegVersion, ffprobeVersion } from "./ffmpeg.js";
import { runJob } from "./pipeline.js";
import { safeOutputPath, safeUploadId, saveMultipartFile } from "./files.js";

function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const PORT = positiveInteger(process.env.PORT, 8080, { maximum: 65535 });
const HOST = process.env.HOST?.trim() || "0.0.0.0";
const MAX_UPLOAD_MB = positiveInteger(process.env.MAX_UPLOAD_MB, 4096, { maximum: 16_384 });
const JOB_TTL_SECONDS = positiveInteger(process.env.JOB_TTL_SECONDS, 3600, { minimum: 60 });
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const ALLOW_ANY_ORIGIN = CORS_ORIGINS.includes("*");

function allowedSseOrigin(request) {
  const origin = request.headers.origin;
  if (ALLOW_ANY_ORIGIN) return origin || "*";
  if (origin && CORS_ORIGINS.includes(origin)) return origin;
  return CORS_ORIGINS[0] ?? "null";
}

function validatePayload(payload, uploadedFiles) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.files)) {
    throw new Error("missing payload.files array");
  }
  if (payload.files.length === 0) throw new Error("payload.files is empty");
  if (payload.files.length > 10_000) throw new Error("too many files in one job");

  const ids = new Set();
  const files = payload.files.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`file descriptor ${index} is invalid`);
    const id = safeUploadId(raw.id);
    if (ids.has(id)) throw new Error(`duplicate file id: ${id}`);
    ids.add(id);
    safeOutputPath(raw.folder, raw.name);
    return {
      id,
      name: String(raw.name),
      folder: raw.folder == null ? "" : String(raw.folder),
      sequence: Number.isFinite(Number(raw.sequence)) ? Number(raw.sequence) : index + 1,
      overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {},
      excluded: raw.excluded === true,
    };
  });

  for (const id of uploadedFiles.keys()) {
    if (!ids.has(id)) throw new Error(`uploaded file_${id} has no matching payload descriptor`);
  }
  for (const file of files) {
    if (!file.excluded && !uploadedFiles.has(file.id)) {
      throw new Error(`missing uploaded file for id ${file.id}`);
    }
  }
  if (!files.some((file) => !file.excluded)) throw new Error("job contains no included files");

  return {
    settings: payload.settings && typeof payload.settings === "object" ? payload.settings : {},
    files,
  };
}

export async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.abortController.abort();
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  jobs.delete(jobId);
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

function scheduleCleanup(job) {
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  let ttlMs;
  if (job.retention === "24h") ttlMs = 24 * 60 * 60 * 1000;
  else if (job.retention === "immediate" && job.success) ttlMs = JOB_TTL_SECONDS * 1000;
  else if (job.retention === "immediate") ttlMs = 10 * 60 * 1000;
  else ttlMs = JOB_TTL_SECONDS * 1000;
  job.cleanupTimer = setTimeout(() => cleanupJob(job.id).catch(() => {}), ttlMs);
  job.cleanupTimer.unref?.();
}

export async function buildApp({ logger = { level: process.env.LOG_LEVEL ?? "info" } } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: MAX_UPLOAD_MB * 1024 * 1024,
    requestTimeout: 0,
    connectionTimeout: 30_000,
    keepAliveTimeout: 72_000,
  });

  await app.register(cors, {
    origin: ALLOW_ANY_ORIGIN ? true : CORS_ORIGINS,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Last-Event-ID"],
    exposedHeaders: ["Content-Disposition"],
  });

  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_MB * 1024 * 1024,
      files: 10_000,
      fields: 250,
      parts: 10_250,
      fieldSize: 16 * 1024 * 1024,
    },
    throwFileSizeLimit: true,
  });

  await fs.mkdir(WORK_ROOT, { recursive: true });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, "request failed");
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400
      ? error.statusCode
      : 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal server error" : error.message,
      detail: process.env.NODE_ENV === "production" && statusCode >= 500 ? undefined : error.message,
    });
  });

  app.get("/health", async (_request, reply) => {
    try {
      const [ffmpeg, ffprobe] = await Promise.all([ffmpegVersion(), ffprobeVersion()]);
      return {
        status: "ok",
        version: "2.0.0",
        ffmpeg,
        ffprobe,
        targetLufs: -16,
        toleranceLu: 0.3,
        truePeakLimitDbtp: -1.5,
      };
    } catch (error) {
      reply.code(503);
      return { status: "unavailable", error: error.message };
    }
  });

  app.post("/analyze", async (request, reply) => {
    const tempDirectory = path.join(WORK_ROOT, `analyze_${nanoid(12)}`);
    const inputPath = path.join(tempDirectory, "input.mp3");
    await fs.mkdir(tempDirectory, { recursive: true });
    let received = false;
    let relativePath = "";
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file") {
            part.file.resume();
            continue;
          }
          if (received) throw new Error("only one analyze file is allowed");
          await saveMultipartFile(part, inputPath);
          received = true;
        } else if (part.fieldname === "relpath") {
          relativePath = String(part.value ?? "");
        }
      }
      if (!received) {
        reply.code(400);
        return { error: "missing multipart field named file" };
      }
      try {
        return await analyzeMp3(inputPath);
      } catch (error) {
        request.log.warn({ error, relativePath }, "audio analysis rejected input");
        reply.code(422);
        return { error: "invalid or unmeasurable audio", detail: error.message };
      }
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.post("/jobs", async (request, reply) => {
    const jobId = `job_${nanoid(16)}`;
    const jobDirectory = path.join(WORK_ROOT, jobId);
    const inputDirectory = path.join(jobDirectory, "in");
    const outputDirectory = path.join(jobDirectory, "out");
    await fs.mkdir(inputDirectory, { recursive: true });
    await fs.mkdir(outputDirectory, { recursive: true });

    const uploadedFiles = new Map();
    let rawPayload = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "payload") {
            if (rawPayload !== null) throw new Error("duplicate payload field");
            try {
              rawPayload = JSON.parse(String(part.value));
            } catch {
              throw new Error("payload is not valid JSON");
            }
          }
          continue;
        }

        if (!part.fieldname.startsWith("file_")) {
          part.file.resume();
          throw new Error(`unexpected multipart file field: ${part.fieldname}`);
        }
        const id = safeUploadId(part.fieldname.slice(5));
        if (uploadedFiles.has(id)) {
          part.file.resume();
          throw new Error(`duplicate uploaded file id: ${id}`);
        }
        const destination = path.join(inputDirectory, `${id}.mp3`);
        await saveMultipartFile(part, destination);
        uploadedFiles.set(id, destination);
      }

      const validated = validatePayload(rawPayload, uploadedFiles);
      const job = createJob({
        id: jobId,
        dir: jobDirectory,
        inDir: inputDirectory,
        outDir: outputDirectory,
        settings: validated.settings,
        files: validated.files,
        fileMap: uploadedFiles,
      });

      job.once("done", () => scheduleCleanup(job));
      void runJob(job, app.log).catch(async (error) => {
        app.log.error({ error, jobId }, "job crashed");
        await fs.rm(path.join(job.dir, "result.zip"), { force: true }).catch(() => {});
        job.status = "failed";
        job.progress = {
          ...job.progress,
          stage: "failed",
          message: error.message,
        };
        job.emit("progress", job.progress);
        finishJob(job, { status: "failed", success: false, error: error.message });
      });

      return { jobId };
    } catch (error) {
      await fs.rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
      reply.code(error.statusCode ?? 400);
      return { error: error.message ?? "job creation failed" };
    }
  });

  app.get("/jobs/:id", async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    return {
      jobId: job.id,
      status: job.status,
      success: job.success,
      done: job.done,
      error: job.error,
      progress: job.progress,
      files: job.fileResults,
    };
  });

  app.get("/jobs/:id/events", async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": allowedSseOrigin(request),
      Vary: "Origin",
    });
    reply.raw.write("retry: 2000\n\n");

    const send = (event, data) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("progress", job.progress);
    for (const result of job.fileResults) send("file", result);
    if (job.done) {
      send("done", {
        jobId: job.id,
        status: job.status,
        success: job.success,
        error: job.error,
      });
      reply.raw.end();
      return;
    }

    const onProgress = (progress) => send("progress", progress);
    const onFile = (result) => send("file", result);
    const onDone = (result) => {
      send("done", result);
      reply.raw.end();
    };
    job.on("progress", onProgress);
    job.on("file", onFile);
    job.once("done", onDone);

    const keepalive = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": keepalive\n\n");
    }, 15_000);
    keepalive.unref?.();

    request.raw.once("close", () => {
      clearInterval(keepalive);
      job.off("progress", onProgress);
      job.off("file", onFile);
      job.off("done", onDone);
    });
  });

  app.get("/jobs/:id/download", async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    if (!job.done || job.status !== "ready" || !job.success) {
      reply.code(409);
      return { error: job.error ?? "job is not successfully ready" };
    }
    const zipPath = path.join(job.dir, "result.zip");
    try {
      await fs.access(zipPath);
    } catch {
      reply.code(500);
      return { error: "verified job archive is missing" };
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="voice_batch_${job.id}.zip"`);
    const stream = createReadStream(zipPath);
    if (job.retention === "immediate") {
      stream.once("close", () => cleanupJob(job.id).catch(() => {}));
    }
    return reply.send(stream);
  });

  app.get("/jobs/:id/report.csv", async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    const reportPath = path.join(job.dir, "report.csv");
    try {
      await fs.access(reportPath);
    } catch {
      reply.code(409);
      return { error: "report is not ready" };
    }
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="audio_report_${job.id}.csv"`);
    return reply.send(createReadStream(reportPath));
  });

  app.post("/jobs/:id/cancel", async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    if (job.done) {
      reply.code(409);
      return { error: `job is already ${job.status}` };
    }
    job.cancelled = true;
    job.abortController.abort();
    reply.code(202);
    return { status: "cancelling" };
  });

  app.addHook("onClose", async () => {
    for (const job of jobs.values()) job.abortController.abort();
  });

  return app;
}

export async function startServer() {
  const app = await buildApp();
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ host: HOST, port: PORT }, "Voice Batch Studio backend started");
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
