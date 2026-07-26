import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const execFileP = promisify(execFile);
const MAX_CAPTURE_BYTES = Number(process.env.FFMPEG_LOG_CAPTURE_BYTES ?? 2 * 1024 * 1024);

export async function ffmpegVersion() {
  const { stdout } = await execFileP("ffmpeg", ["-version"]);
  const m = stdout.match(/ffmpeg version (\S+)/);
  return m ? m[1] : "unknown";
}

export async function ffprobeJson(input) {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    input,
  ], { maxBuffer: MAX_CAPTURE_BYTES });
  return JSON.parse(stdout);
}

function appendBounded(current, chunk, maxBytes) {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return next.slice(-maxBytes);
}

/**
 * Runs one FFmpeg child process asynchronously.
 * Output capture is bounded so a malformed/noisy file cannot grow memory forever.
 */
export function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-nostdin", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout = appendBounded(stdout, d, MAX_CAPTURE_BYTES);
    });
    child.stderr.on("data", (d) => {
      stderr = appendBounded(stderr, d, MAX_CAPTURE_BYTES);
    });
    child.on("error", reject);
    child.on("close", (code, childSignal) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const suffix = childSignal ? ` (signal ${childSignal})` : "";
        reject(new Error(`ffmpeg exited ${code}${suffix}: ${stderr.slice(-1200)}`));
      }
    });
  });
}

/** Extract loudnorm JSON block from FFmpeg stderr. */
export function parseLoudnormJson(stderr) {
  const matches = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/g);
  if (!matches?.length) return null;
  try {
    return JSON.parse(matches[matches.length - 1]);
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
 * Measures loudness and volume in one FFmpeg decode by splitting the audio.
 * This replaces two independent full-file FFmpeg executions without changing
 * either filter's calculation.
 */
async function measureAudio(input, targetLufs = -16, lraTarget = 7, truePeakTarget = -1.5) {
  const filter =
    `[0:a]asplit=2[loud][volume];` +
    `[loud]loudnorm=I=${targetLufs}:LRA=${lraTarget}:TP=${truePeakTarget}:print_format=json[loudout];` +
    `[volume]volumedetect[volumeout]`;
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-i", input,
    "-filter_complex", filter,
    "-map", "[loudout]", "-f", "null", "-",
    "-map", "[volumeout]", "-f", "null", "-",
  ]);

  const loudness = parseLoudnormJson(stderr);
  const maxPeakMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)/);
  const rmsMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)/);
  return {
    lufs: loudness ? Number(loudness.input_i) : undefined,
    lra: loudness ? Number(loudness.input_lra) : undefined,
    truePeak: loudness ? Number(loudness.input_tp) : undefined,
    maxPeak: maxPeakMatch ? Number(maxPeakMatch[1]) : undefined,
    rms: rmsMatch ? Number(rmsMatch[1]) : undefined,
  };
}

/** Full single-file analysis. */
export async function analyzeMp3(inPath) {
  const stat = await fs.stat(inPath);
  let probe;
  try {
    probe = await ffprobeJson(inPath);
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

  let measurements = {};
  try {
    measurements = await measureAudio(inPath);
  } catch {
    // Preserve prior behavior: metadata is still returned if measurement fails.
  }

  const { lufs, lra, truePeak, maxPeak, rms } = measurements;
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
