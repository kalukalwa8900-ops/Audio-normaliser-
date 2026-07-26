import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { nanoid } from "nanoid";
import { promises as fs, createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import archiver from "archiver";
import { createJob, getJob, jobs, WORK_ROOT } from "./jobs.js";
import { analyzeMp3, ffmpegVersion } from "./ffmpeg.js";
import { runJob } from "./pipeline.js";
import { FFMPEG_WORKERS, detectedCpuCount } from "./concurrency.js";

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 4096);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS ?? 3600);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: MAX_UPLOAD_MB * 1024 * 1024,
});

await app.register(cors, {
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
  credentials: false,
});

await app.register(multipart, {
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 10000,
    fields: 200,
  },
});

await fs.mkdir(WORK_ROOT, { recursive: true });

// ---- Health ----
app.get("/health", async () => {
  let ff = "unknown";
  try {
    ff = await ffmpegVersion();
  } catch {}
  return { version: "1.1.0", ffmpeg: ff, cpuCount: detectedCpuCount(), ffmpegWorkers: FFMPEG_WORKERS };
});

// ---- Analyze one file ----
app.post("/analyze", async (req, reply) => {
  const tmpDir = path.join(WORK_ROOT, `analyze_${nanoid(10)}`);
  await fs.mkdir(tmpDir, { recursive: true });
  let inPath = null;
  let relpath = "";
  try {
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "file") {
        inPath = path.join(tmpDir, "in.mp3");
        await new Promise((resolve, reject) => {
          const ws = createWriteStream(inPath);
          part.file.pipe(ws);
          ws.on("finish", resolve);
          ws.on("error", reject);
          part.file.on("error", reject);
        });
      } else if (part.type === "field" && part.fieldname === "relpath") {
        relpath = String(part.value ?? "");
      }
    }
    if (!inPath) {
      reply.code(400);
      return { error: "missing file" };
    }
    const analysis = await analyzeMp3(inPath);
    return analysis;
  } catch (err) {
    req.log.error({ err, relpath }, "analyze failed");
    reply.code(500);
    return { error: err.message ?? "analyze failed" };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---- Create job ----
app.post("/jobs", async (req, reply) => {
  const jobId = `job_${nanoid(16)}`;
  const jobDir = path.join(WORK_ROOT, jobId);
  const inDir = path.join(jobDir, "in");
  const outDir = path.join(jobDir, "out");
  await fs.mkdir(inDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  let payload = null;
  const fileMap = new Map(); // id -> local path

  try {
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "field" && part.fieldname === "payload") {
        payload = JSON.parse(String(part.value));
      } else if (part.type === "file" && part.fieldname.startsWith("file_")) {
        const id = part.fieldname.slice("file_".length);
        const dest = path.join(inDir, `${id}.mp3`);
        await new Promise((resolve, reject) => {
          const ws = createWriteStream(dest);
          part.file.pipe(ws);
          ws.on("finish", resolve);
          ws.on("error", reject);
          part.file.on("error", reject);
        });
        fileMap.set(id, dest);
      }
    }
    if (!payload || !Array.isArray(payload.files)) {
      reply.code(400);
      return { error: "missing payload.files" };
    }

    const job = createJob({
      id: jobId,
      dir: jobDir,
      inDir,
      outDir,
      settings: payload.settings,
      files: payload.files,
      fileMap,
    });

    // Fire and forget — SSE will report progress.
    runJob(job, app.log).catch((err) => {
      app.log.error({ err, jobId }, "job crashed");
      job.progress = { ...job.progress, stage: "failed", message: err.message };
      job.emit("progress", job.progress);
    });

    // Auto-cleanup by retention
    const retention = payload.settings?.retention ?? "1h";
    if (retention !== "immediate") {
      const ttlMs = retention === "24h" ? 24 * 3600 * 1000 : JOB_TTL_SECONDS * 1000;
      setTimeout(() => cleanupJob(jobId).catch(() => {}), ttlMs).unref?.();
    }

    return { jobId };
  } catch (err) {
    req.log.error({ err }, "create job failed");
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    reply.code(500);
    return { error: err.message ?? "create job failed" };
  }
});

// ---- SSE progress ----
app.get("/jobs/:id/events", async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) {
    reply.code(404);
    return { error: "job not found" };
  }
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": corsHeader(req),
  });
  reply.raw.write(`retry: 2000\n\n`);

  const send = (event, data) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Replay latest state
  if (job.progress) send("progress", job.progress);
  for (const f of job.fileResults) send("file", f);
  if (job.done) {
    send("done", { jobId: job.id });
    reply.raw.end();
    return;
  }

  const onProgress = (p) => send("progress", p);
  const onFile = (f) => send("file", f);
  const onDone = () => {
    send("done", { jobId: job.id });
    reply.raw.end();
  };

  job.on("progress", onProgress);
  job.on("file", onFile);
  job.on("done", onDone);

  const keepalive = setInterval(() => {
    reply.raw.write(`: keepalive\n\n`);
  }, 15000);

  req.raw.on("close", () => {
    clearInterval(keepalive);
    job.off("progress", onProgress);
    job.off("file", onFile);
    job.off("done", onDone);
  });

  return reply;
});

// ---- Download final ZIP ----
app.get("/jobs/:id/download", async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) {
    reply.code(404);
    return { error: "job not found" };
  }
  const zipPath = path.join(job.dir, "result.zip");
  try {
    await fs.access(zipPath);
  } catch {
    reply.code(409);
    return { error: "job not ready" };
  }
  reply.header("Content-Type", "application/zip");
  reply.header(
    "Content-Disposition",
    `attachment; filename="voice_batch_${job.id}.zip"`,
  );
  const stream = createReadStream(zipPath);
  reply.send(stream);

  if (job.retention === "immediate") {
    stream.on("close", () => cleanupJob(job.id).catch(() => {}));
  }
  return reply;
});

// ---- Report ----
app.get("/jobs/:id/report.csv", async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) {
    reply.code(404);
    return { error: "job not found" };
  }
  const csvPath = path.join(job.dir, "report.csv");
  try {
    await fs.access(csvPath);
  } catch {
    reply.code(409);
    return { error: "report not ready" };
  }
  reply.header("Content-Type", "text/csv");
  reply.send(createReadStream(csvPath));
  return reply;
});

// ---- Cancel ----
app.post("/jobs/:id/cancel", async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) {
    reply.code(404);
    return { error: "job not found" };
  }
  job.cancelled = true;
  reply.code(204).send();
});

// ---- helpers ----
function corsHeader(req) {
  const origin = req.headers.origin;
  if (!origin) return "*";
  if (CORS_ORIGIN === "*") return origin;
  const allowed = CORS_ORIGIN.split(",").map((s) => s.trim());
  return allowed.includes(origin) ? origin : allowed[0];
}

async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.delete(jobId);
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

// Export archiver so ESM tree-shaking keeps it (used inside pipeline.js).
export { archiver };

app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`Voice Batch Studio backend listening on ${HOST}:${PORT}`);
});
