import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const execFileP = promisify(execFile);

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
  ]);
  return JSON.parse(stdout);
}

/**
 * Runs ffmpeg with args, returns { stdout, stderr, code }.
 * Uses spawn so we can capture stderr even on failure.
 */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
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

  // Loudness measurement + volumedetect for peak
  let lufs, lra, truePeak;
  try {
    const { stderr } = await runFfmpeg([
      "-hide_banner",
      "-i", inPath,
      "-af", "loudnorm=I=-16:LRA=7:TP=-1.5:print_format=json",
      "-f", "null",
      "-",
    ]);
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
    ]);
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
