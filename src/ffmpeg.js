import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const execFileP = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function appendBounded(current, chunk, maxBytes = MAX_CAPTURE_BYTES) {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return next.slice(-maxBytes);
}

async function commandVersion(command) {
  const { stdout } = await execFileP(command, ["-version"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(new RegExp(`${command} version (\\S+)`));
  return match ? match[1] : "unknown";
}

export function ffmpegVersion() {
  return commandVersion("ffmpeg");
}

export function ffprobeVersion() {
  return commandVersion("ffprobe");
}

export async function ffprobeJson(input, { signal } = {}) {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    input,
  ], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return JSON.parse(stdout);
}

/**
 * Runs ffmpeg without a shell. Captured output is bounded to prevent long jobs
 * from retaining unbounded stderr in memory. AbortSignal cancellation stops the
 * child process and escalates to SIGKILL if it does not exit promptly.
 */
export function runFfmpeg(args, { signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    let timeout = null;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const terminate = (reason) => {
      if (child.exitCode != null || child.killed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 3000);
      killTimer.unref?.();
      if (reason) stderr = appendBounded(stderr, `\n${reason}\n`);
    };

    const onAbort = () => terminate("ffmpeg aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => terminate(`ffmpeg timed out after ${timeoutMs}ms`), timeoutMs)
      : null;
    timeout?.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", finishReject);
    child.on("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        const error = new Error("ffmpeg operation cancelled");
        error.name = "AbortError";
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const tail = stderr.slice(-1600).trim();
      reject(new Error(`ffmpeg exited ${code ?? "null"}${childSignal ? ` (${childSignal})` : ""}: ${tail}`));
    });
  });
}

/** Extract the final valid loudnorm JSON object from ffmpeg stderr. */
export function parseLoudnormJson(stderr) {
  const matches = String(stderr ?? "").match(/\{[^{}]*\}/gs) ?? [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(matches[index]);
      if (Object.hasOwn(parsed, "input_i") && Object.hasOwn(parsed, "input_tp")) {
        return parsed;
      }
    } catch {
      // Continue to an earlier JSON-looking block.
    }
  }
  return null;
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export async function measureLoudness(input, {
  targetLufs = -16,
  targetLra = 7,
  truePeak = -1.5,
  signal,
} = {}) {
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-i", input,
    "-map", "0:a:0",
    "-af", `loudnorm=I=${targetLufs}:LRA=${targetLra}:TP=${truePeak}:print_format=json`,
    "-f", "null",
    "-",
  ], { signal });
  const measured = parseLoudnormJson(stderr);
  if (!measured) throw new Error("FFmpeg loudnorm did not return measurement JSON");
  return measured;
}

function classify(lufs, clipping) {
  if (clipping) return "clipping";
  if (!Number.isFinite(lufs)) return "unknown";
  if (lufs < -30) return "very_quiet";
  if (lufs < -20) return "quiet";
  if (lufs < -14) return "normal";
  if (lufs < -9) return "loud";
  return "very_loud";
}

/** Full single-file metadata and EBU R128 analysis. */
export async function analyzeMp3(input, { signal } = {}) {
  const stat = await fs.stat(input);
  const probe = await ffprobeJson(input, { signal });
  const stream = (probe.streams ?? []).find((item) => item.codec_type === "audio");
  if (!stream) throw new Error("input contains no audio stream");

  const format = probe.format ?? {};
  const duration = Number(format.duration ?? stream.duration ?? 0) || 0;
  const bitrate = Number(format.bit_rate ?? stream.bit_rate ?? 0) || undefined;
  const sampleRate = Number(stream.sample_rate ?? 0) || undefined;
  const channels = Number(stream.channels ?? 0) || undefined;
  const codec = stream.codec_name ?? undefined;

  const loudnorm = await measureLoudness(input, { signal });
  const lufs = finiteMetric(loudnorm.input_i);
  const lra = finiteMetric(loudnorm.input_lra);
  const truePeak = finiteMetric(loudnorm.input_tp);
  const threshold = finiteMetric(loudnorm.input_thresh);
  const clipping = Number.isFinite(truePeak) && truePeak > 0;
  const warnings = [];
  if (clipping) warnings.push("True peak exceeds 0 dBTP");
  if (Number.isFinite(lufs) && lufs < -30) warnings.push("Very low integrated loudness");
  if (duration < 1) warnings.push("Very short file");

  return {
    duration,
    size: stat.size,
    codec,
    bitrate,
    sampleRate,
    channels,
    lufs,
    lra,
    truePeak,
    threshold,
    clipping,
    warnings,
    classification: classify(lufs, clipping),
  };
}

/** Measure sample-domain mean/max volume for preconditioning audio below R128's absolute gate. */
export async function measureVolume(input, { signal } = {}) {
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-i", input,
    "-map", "0:a:0",
    "-af", "volumedetect",
    "-f", "null",
    "-",
  ], { signal });
  const maxMatch = stderr.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  const meanMatch = stderr.match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  const parse = (match) => {
    if (!match || /inf/i.test(match[1])) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  };
  return { maxVolumeDb: parse(maxMatch), meanVolumeDb: parse(meanMatch) };
}
