import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const execFileP = promisify(execFile);
const MAX_FFMPEG_PROCESSES = Math.max(1, Math.min(8, Number.parseInt(process.env.FFMPEG_WORKERS ?? process.env.WORKER_COUNT ?? "2", 10) || 2));
let activeFfmpeg = 0;
const ffmpegQueue = [];

function acquireFfmpegSlot(signal) {
  if (signal?.aborted) return Promise.reject(new Error("operation cancelled"));
  if (activeFfmpeg < MAX_FFMPEG_PROCESSES) {
    activeFfmpeg += 1;
    return Promise.resolve(releaseFfmpegSlot);
  }
  return new Promise((resolve, reject) => {
    const item = { resolve, reject, signal, onAbort: null };
    item.onAbort = () => {
      const idx = ffmpegQueue.indexOf(item);
      if (idx >= 0) ffmpegQueue.splice(idx, 1);
      reject(new Error("operation cancelled"));
    };
    signal?.addEventListener("abort", item.onAbort, { once: true });
    ffmpegQueue.push(item);
  });
}

function releaseFfmpegSlot() {
  const next = ffmpegQueue.shift();
  if (!next) {
    activeFfmpeg = Math.max(0, activeFfmpeg - 1);
    return;
  }
  next.signal?.removeEventListener("abort", next.onAbort);
  if (next.signal?.aborted) {
    next.reject(new Error("operation cancelled"));
    releaseFfmpegSlot();
    return;
  }
  next.resolve(releaseFfmpegSlot);
}

export async function ffmpegVersion() {
  const { stdout } = await execFileP("ffmpeg", ["-version"]);
  const m = stdout.match(/ffmpeg version (\S+)/);
  return m ? m[1] : "unknown";
}

export async function ffprobeJson(input, options = {}) {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    input,
  ], { signal: options.signal });
  return JSON.parse(stdout);
}

/**
 * Runs ffmpeg with args, returns { stdout, stderr, code }.
 * Uses spawn so we can capture stderr even on failure.
 */
export async function runFfmpeg(args, options = {}) {
  const release = await acquireFfmpegSlot(options.signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("ffmpeg", args, { signal: options.signal });
    options.onChild?.(child);
    let stdout = "";
    let stderr = "";
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      release();
      options.onChild?.(null);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(reject, new Error("operation cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (code === 0) finish(resolve, { stdout, stderr, code });
      else finish(reject, new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Extract loudnorm JSON block from ffmpeg stderr.
 */
export function parseLoudnormJson(stderr) {
  // ffmpeg prints the JSON near the end
  const m = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function classify(lufs, clipping) {
  if (clipping) return "clipping";
  if (lufs === undefined || lufs === null || !isFinite(lufs)) return "unknown";
  if (lufs < -30) return "very_quiet";
  if (lufs < -20) return "quiet";
  if (lufs < -14) return "normal";
  if (lufs < -9) return "loud";
  return "very_loud";
}

/**
 * Full single-file analysis.
 */
export async function analyzeMp3(inPath, options = {}) {
  const stat = await fs.stat(inPath);
  let probe;
  try {
    probe = await ffprobeJson(inPath, options);
  } catch (err) {
    return {
      duration: 0,
      size: stat.size,
      classification: "corrupted",
      warnings: ["ffprobe failed"],
      error: err.message,
    };
  }

  const stream = (probe.streams ?? []).find((s) => s.codec_type === "audio") ?? {};
  const fmt = probe.format ?? {};
  const duration = Number(fmt.duration ?? stream.duration ?? 0) || 0;
  const bitrate = Number(fmt.bit_rate ?? stream.bit_rate ?? 0) || undefined;
  const sampleRate = Number(stream.sample_rate ?? 0) || undefined;
  const channels = Number(stream.channels ?? 0) || undefined;
  const codec = stream.codec_name ?? undefined;

  // Loudness measurement + volumedetect for peak
  let lufs, lra, truePeak;
  try {
    const { stderr } = await runFfmpeg([
      "-hide_banner",
      "-i", inPath,
      "-af", "loudnorm=I=-16:LRA=7:TP=-1.5:print_format=json",
      "-f", "null",
      "-",
    ], options);
    const j = parseLoudnormJson(stderr);
    if (j) {
      lufs = Number(j.input_i);
      lra = Number(j.input_lra);
      truePeak = Number(j.input_tp);
    }
  } catch (err) {
    // continue
  }

  let maxPeak, rms;
  try {
    const { stderr } = await runFfmpeg([
      "-hide_banner",
      "-i", inPath,
      "-af", "volumedetect",
      "-f", "null",
      "-",
    ], options);
    const mp = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)/);
    const rm = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)/);
    if (mp) maxPeak = Number(mp[1]);
    if (rm) rms = Number(rm[1]);
  } catch {}

  const clipping = (truePeak ?? -Infinity) > 0 || (maxPeak ?? -Infinity) >= 0;
  const warnings = [];
  if (clipping) warnings.push("True peak exceeds 0 dBTP");
  if ((lufs ?? 0) < -30) warnings.push("Very low volume");
  if (duration < 1) warnings.push("Very short file");

  return {
    duration,
    size: stat.size,
    codec,
    bitrate,
    sampleRate,
    channels,
    lufs: isFinite(lufs) ? lufs : undefined,
    lra: isFinite(lra) ? lra : undefined,
    truePeak: isFinite(truePeak) ? truePeak : undefined,
    rms,
    maxPeak,
    silencePct: undefined,
    clipping,
    warnings,
    classification: classify(lufs, clipping),
  };
}
