import { promises as fs, createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { analyzeMp3, measureLoudness, measureVolume, runFfmpeg } from "./ffmpeg.js";
import { createFfmpegLimiter } from "./concurrency.js";
import { csvEscape, safeOutputPath } from "./files.js";
import { finishJob } from "./jobs.js";

export const REQUIRED_TARGET_LUFS = -16;
export const REQUIRED_TOLERANCE_LU = 0.3;
export const REQUIRED_TRUE_PEAK_DBTP = -1.5;
const DEFAULT_TARGET_LRA = 7;
const MAX_NORMALIZATION_ATTEMPTS = 3;

const PRESET_CHAINS = Object.freeze({
  original: [],
  voice_focus: [
    "highpass=f=80",
    "equalizer=f=250:t=q:w=1:g=-2",
    "equalizer=f=3000:t=q:w=1:g=2",
  ],
  clear_narration: [
    "highpass=f=90",
    "equalizer=f=200:t=q:w=1:g=-1.5",
    "equalizer=f=4000:t=q:w=1:g=1.5",
  ],
  sweet_voice: [
    "highpass=f=70",
    "equalizer=f=350:t=q:w=1:g=1",
    "equalizer=f=5000:t=q:w=1:g=1.5",
  ],
  deep_narration: [
    "highpass=f=60",
    "equalizer=f=120:t=q:w=1:g=2",
    "equalizer=f=3500:t=q:w=1:g=1",
  ],
  bright_voice: [
    "highpass=f=100",
    "equalizer=f=6000:t=q:w=1:g=3",
    "equalizer=f=10000:t=q:w=1:g=2",
  ],
  podcast: [
    "highpass=f=80",
    "equalizer=f=200:t=q:w=1:g=-1",
    "equalizer=f=3000:t=q:w=1:g=1.5",
    "equalizer=f=8000:t=q:w=1:g=1",
  ],
  noisy_repair: [
    "afftdn=nr=20",
    "highpass=f=100",
    "equalizer=f=3000:t=q:w=1:g=1.5",
  ],
});

const limiterPromise = createFfmpegLimiter();
const execFileP = promisify(execFile);

function finiteNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function atempoChain(value) {
  const speed = finiteNumber(value, 1, 0.25, 4);
  if (Math.abs(speed - 1) < 0.0001) return [];
  const filters = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) >= 0.0001) filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters;
}

function buildProcessingFilters(settings, overrides = {}) {
  const values = { ...settings, ...overrides };
  const mode = values.mode === "normalize" ? "normalize" : "normalize_enhance";
  const preset = Object.hasOwn(PRESET_CHAINS, values.preset) ? values.preset : "original";
  const filters = [];
  const speedFilters = atempoChain(values.speed);

  if (values.speedBeforeEnhance) filters.push(...speedFilters);

  if (mode !== "normalize") {
    const noiseReduction = finiteNumber(values.noiseReduction, 0, 0, 1);
    if (noiseReduction > 0.05) filters.push(`afftdn=nr=${Math.round(noiseReduction * 24)}`);

    const highPass = finiteNumber(values.highPass, 0, 0, 20_000);
    const lowPass = finiteNumber(values.lowPass, 20_000, 20, 22_000);
    if (highPass > 20) filters.push(`highpass=f=${highPass.toFixed(0)}`);
    if (lowPass < 20_000) filters.push(`lowpass=f=${lowPass.toFixed(0)}`);

    filters.push(...PRESET_CHAINS[preset]);

    const eqBands = [
      ["bass", 120],
      ["mid", 1000],
      ["presence", 3500],
      ["treble", 8000],
    ];
    for (const [key, frequency] of eqBands) {
      const gain = finiteNumber(values[key], 0, -12, 12);
      if (Math.abs(gain) > 0.001) {
        filters.push(`equalizer=f=${frequency}:t=q:w=1:g=${gain.toFixed(2)}`);
      }
    }

    const deesser = finiteNumber(values.deesserStrength, 0, 0, 1);
    if (deesser > 0.1) {
      filters.push(`equalizer=f=6500:t=q:w=1.5:g=${(-deesser * 6).toFixed(2)}`);
    }

    const ratio = finiteNumber(values.compressionRatio, 1, 1, 20);
    if (ratio > 1.001) {
      const threshold = finiteNumber(values.compressionThreshold, -20, -60, 0);
      const attack = finiteNumber(values.attack, 10, 0.01, 2000);
      const release = finiteNumber(values.release, 120, 1, 9000);
      const makeupDb = finiteNumber(values.makeupGain, 0, 0, 36);
      const makeup = Math.min(64, Math.max(1, 10 ** (makeupDb / 20)));
      filters.push(
        `acompressor=threshold=${threshold.toFixed(2)}dB:ratio=${ratio.toFixed(2)}` +
        `:attack=${attack.toFixed(2)}:release=${release.toFixed(2)}:makeup=${makeup.toFixed(4)}`,
      );
    }

    if (values.limiterEnabled === true) {
      const limiterDb = finiteNumber(values.limiterCeiling, -1, -12, -0.1);
      const limiterLinear = 10 ** (limiterDb / 20);
      filters.push(`alimiter=limit=${limiterLinear.toFixed(6)}:level=false`);
    }
  }

  if (!values.speedBeforeEnhance) filters.push(...speedFilters);

  const fadeIn = finiteNumber(values.fadeIn, 0, 0, 30);
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);

  return filters;
}

export function resolveExportSettings(settings) {
  let bitrateValue = Number(settings.outputBitrate);
  if (!Number.isFinite(bitrateValue) || settings.outputBitrate === "preserve") bitrateValue = 192_000;
  if (bitrateValue <= 320) bitrateValue *= 1000;
  const bitrateKbps = Math.round(finiteNumber(bitrateValue / 1000, 192, 64, 320));

  let sampleRate = Number(settings.outputSampleRate);
  if (![32_000, 44_100, 48_000].includes(sampleRate)) sampleRate = 48_000;

  let channels = 2;
  if (settings.outputChannels === "mono" || Number(settings.outputChannels) === 1) channels = 1;
  if (settings.outputChannels === "stereo" || Number(settings.outputChannels) === 2) channels = 2;

  return Object.freeze({
    codec: "libmp3lame",
    bitrateKbps,
    sampleRate,
    channels,
  });
}

function validLoudnormMeasurement(measured) {
  const fields = ["input_i", "input_lra", "input_tp", "input_thresh", "target_offset"];
  return Boolean(measured) && fields.every((field) => Number.isFinite(Number(measured[field])));
}

export function verificationResult(analysis) {
  const integrated = Number(analysis?.lufs);
  const truePeak = Number(analysis?.truePeak);
  const loudnessDeviation = Number.isFinite(integrated)
    ? Math.abs(integrated - REQUIRED_TARGET_LUFS)
    : Infinity;
  const loudnessPassed = Number.isFinite(integrated) && loudnessDeviation <= REQUIRED_TOLERANCE_LU + 1e-9;
  const truePeakPassed = Number.isFinite(truePeak) && truePeak <= REQUIRED_TRUE_PEAK_DBTP + 1e-9;
  return {
    passed: loudnessPassed && truePeakPassed,
    loudnessPassed,
    truePeakPassed,
    loudnessDeviation,
    integrated,
    truePeak,
  };
}

function buildSecondPassFilter(measured, { targetLufs, targetLra, truePeak, linear }) {
  if (!validLoudnormMeasurement(measured)) {
    throw new Error("first-pass loudnorm measurement was incomplete or non-finite");
  }
  return `loudnorm=I=${targetLufs}:LRA=${targetLra}:TP=${truePeak}` +
    `:measured_I=${Number(measured.input_i)}` +
    `:measured_LRA=${Number(measured.input_lra)}` +
    `:measured_TP=${Number(measured.input_tp)}` +
    `:measured_thresh=${Number(measured.input_thresh)}` +
    `:offset=${Number(measured.target_offset)}` +
    `:linear=${linear ? "true" : "false"}:print_format=json`;
}

async function prepareMeasurableStage({ stagedPath, stageDirectory, targetLra, signal }) {
  const preliminary = await measureLoudness(stagedPath, {
    targetLufs: REQUIRED_TARGET_LUFS,
    targetLra,
    truePeak: REQUIRED_TRUE_PEAK_DBTP,
    signal,
  });
  if (validLoudnormMeasurement(preliminary)) {
    return { normalizationInput: stagedPath, preconditioningGainDb: 0 };
  }

  const volume = await measureVolume(stagedPath, { signal });
  if (!Number.isFinite(volume.maxVolumeDb)) {
    throw new Error("audio is digitally silent or has no measurable samples");
  }

  // Raise the peak only enough to cross R128's absolute gate with safe headroom.
  // This is a preconditioner before Pass 1, never a replacement for loudnorm.
  const gainDb = finiteNumber(-12 - volume.maxVolumeDb, 0, 0, 60);
  if (gainDb <= 0) {
    throw new Error("audio is unmeasurable by EBU R128 despite having non-silent samples");
  }
  const conditionedPath = path.join(stageDirectory, "preconditioned.wav");
  await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-y",
    "-i", stagedPath,
    "-map", "0:a:0",
    "-af", `volume=${gainDb.toFixed(3)}dB`,
    "-c:a", "pcm_f32le",
    conditionedPath,
  ], { signal });

  const conditionedMeasurement = await measureLoudness(conditionedPath, {
    targetLufs: REQUIRED_TARGET_LUFS,
    targetLra,
    truePeak: REQUIRED_TRUE_PEAK_DBTP,
    signal,
  });
  if (!validLoudnormMeasurement(conditionedMeasurement)) {
    throw new Error("quiet-audio preconditioning could not produce a valid R128 measurement");
  }
  return { normalizationInput: conditionedPath, preconditioningGainDb: gainDb };
}

async function renderAttempt({
  stagedPath,
  sourcePath,
  outputPath,
  exportSettings,
  targetLra,
  targetLufs,
  normalizationTruePeak,
  linear,
  signal,
}) {
  // Pass 1: measure the exact post-preset/post-compressor audio that will be normalized.
  const measured = await measureLoudness(stagedPath, {
    targetLufs,
    targetLra,
    truePeak: normalizationTruePeak,
    signal,
  });
  if (!validLoudnormMeasurement(measured)) {
    throw new Error(
      `first-pass loudnorm could not measure this file (I=${measured?.input_i ?? "missing"}, ` +
      `LRA=${measured?.input_lra ?? "missing"}, TP=${measured?.input_tp ?? "missing"}, ` +
      `threshold=${measured?.input_thresh ?? "missing"})`,
    );
  }

  // Pass 2: apply loudnorm using every measured first-pass value. No filters are
  // placed after loudnorm; this protects the final integrated loudness.
  const loudnormFilter = buildSecondPassFilter(measured, {
    targetLufs,
    targetLra,
    truePeak: normalizationTruePeak,
    linear,
  });
  await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-y",
    "-i", stagedPath,
    "-i", sourcePath,
    "-map", "0:a:0",
    "-map_metadata", "1",
    "-af", loudnormFilter,
    "-ar", String(exportSettings.sampleRate),
    "-ac", String(exportSettings.channels),
    "-c:a", exportSettings.codec,
    "-b:a", `${exportSettings.bitrateKbps}k`,
    "-id3v2_version", "3",
    "-write_xing", "1",
    outputPath,
  ], { signal });

  const finalAnalysis = await analyzeMp3(outputPath, { signal });
  return { measured, finalAnalysis, verification: verificationResult(finalAnalysis) };
}

export async function processFile({ job, file, log }) {
  const signal = job.abortController.signal;
  const sourcePath = job.fileMap.get(file.id);
  if (!sourcePath) throw new Error("input file is missing");
  if (signal.aborted) throw Object.assign(new Error("job cancelled"), { name: "AbortError" });

  const outputRelative = safeOutputPath(file.folder, file.name);
  const outputPath = path.join(job.outDir, ...outputRelative.split("/"));
  const resolvedOutput = path.resolve(outputPath);
  const outputRoot = `${path.resolve(job.outDir)}${path.sep}`;
  if (!resolvedOutput.startsWith(outputRoot)) throw new Error("unsafe output path");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const originalAnalysis = await analyzeMp3(sourcePath, { signal });
  const stageDirectory = path.join(job.dir, `stage_${file.id}`);
  const stagedPath = path.join(stageDirectory, "post_filters.wav");
  await fs.mkdir(stageDirectory, { recursive: true });

  try {
    const preFilters = buildProcessingFilters(job.settings, file.overrides ?? {});
    const stageArgs = [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i", sourcePath,
      "-map", "0:a:0",
    ];
    if (preFilters.length > 0) stageArgs.push("-af", preFilters.join(","));
    stageArgs.push(
      "-ar", String(job.exportSettings.sampleRate),
      "-ac", String(job.exportSettings.channels),
      "-c:a", "pcm_f32le",
      stagedPath,
    );
    await runFfmpeg(stageArgs, { signal });

    const targetLra = finiteNumber(job.settings.loudnessRange, DEFAULT_TARGET_LRA, 1, 20);
    const { normalizationInput, preconditioningGainDb } = await prepareMeasurableStage({
      stagedPath,
      stageDirectory,
      targetLra,
      signal,
    });
    const attempts = [];
    let correction = 0;

    for (let attempt = 1; attempt <= MAX_NORMALIZATION_ATTEMPTS; attempt += 1) {
      const targetLufs = REQUIRED_TARGET_LUFS + correction;
      const normalizationTruePeak = attempt === 1 ? REQUIRED_TRUE_PEAK_DBTP : -1.8;
      const linear = attempt === 1;
      await fs.rm(outputPath, { force: true }).catch(() => {});

      const attemptResult = await renderAttempt({
        stagedPath: normalizationInput,
        sourcePath,
        outputPath,
        exportSettings: job.exportSettings,
        targetLra,
        targetLufs,
        normalizationTruePeak,
        linear,
        signal,
      });
      attempts.push({
        attempt,
        targetLufs,
        normalizationTruePeak,
        linear,
        pass1: attemptResult.measured,
        finalLufs: attemptResult.finalAnalysis.lufs,
        finalTruePeak: attemptResult.finalAnalysis.truePeak,
        verification: attemptResult.verification,
      });

      if (attemptResult.verification.passed) {
        const outputStat = await fs.stat(outputPath);
        return {
          originalAnalysis,
          finalAnalysis: attemptResult.finalAnalysis,
          pass1Measurement: attemptResult.measured,
          attempts,
          result: {
            finalLufs: attemptResult.finalAnalysis.lufs,
            finalTruePeak: attemptResult.finalAnalysis.truePeak,
            finalDuration: attemptResult.finalAnalysis.duration,
            outputSize: outputStat.size,
            codec: job.exportSettings.codec,
            bitrate: job.exportSettings.bitrateKbps * 1000,
            sampleRate: job.exportSettings.sampleRate,
            channels: job.exportSettings.channels,
            loudnessDeviation: attemptResult.verification.loudnessDeviation,
            verificationPassed: true,
            attempts: attempt,
            preconditioningGainDb,
          },
        };
      }

      log.warn?.({
        jobId: job.id,
        fileId: file.id,
        attempt,
        finalLufs: attemptResult.finalAnalysis.lufs,
        finalTruePeak: attemptResult.finalAnalysis.truePeak,
        loudnessDeviation: attemptResult.verification.loudnessDeviation,
      }, "strict output verification failed; retrying with a fresh two-pass measurement");

      if (Number.isFinite(attemptResult.finalAnalysis.lufs)) {
        correction = finiteNumber(
          correction + (REQUIRED_TARGET_LUFS - attemptResult.finalAnalysis.lufs),
          0,
          -3.0,
          3.0,
        );
      }
    }

    const last = attempts.at(-1);
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw new Error(
      `file ${file.name} failed strict verification after ${MAX_NORMALIZATION_ATTEMPTS} true two-pass attempts: ` +
      `integrated=${last?.finalLufs ?? "unmeasurable"} LUFS (required ${REQUIRED_TARGET_LUFS} ±${REQUIRED_TOLERANCE_LU}), ` +
      `truePeak=${last?.finalTruePeak ?? "unmeasurable"} dBTP (required <= ${REQUIRED_TRUE_PEAK_DBTP})`,
    );
  } finally {
    await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeReport(job, rows) {
  const header = [
    "sequence",
    "original_filename",
    "folder_path",
    "original_duration_seconds",
    "original_lufs",
    "original_lra",
    "original_true_peak_dbtp",
    "original_bitrate_bps",
    "original_sample_rate_hz",
    "original_channels",
    "pass1_measured_i",
    "pass1_measured_lra",
    "pass1_measured_tp",
    "pass1_measured_threshold",
    "pass1_target_offset",
    "preconditioning_gain_db",
    "final_lufs",
    "loudness_deviation_lu",
    "final_true_peak_dbtp",
    "final_duration_seconds",
    "final_bitrate_bps",
    "final_sample_rate_hz",
    "final_channels",
    "normalization_attempts",
    "processing_status",
    "error_message",
  ];
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  await fs.writeFile(path.join(job.dir, "report.csv"), `${lines.join("\n")}\n`, "utf8");
}

async function packageZip(job) {
  const zipPath = path.join(job.dir, "result.zip");
  await fs.rm(zipPath, { force: true }).catch(() => {});

  try {
    const { default: archiver } = await import("archiver");
    await new Promise((resolve, reject) => {
      const output = createWriteStream(zipPath, { flags: "wx" });
      const archive = archiver("zip", { zlib: { level: 6 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("warning", (error) => {
        if (error.code !== "ENOENT") reject(error);
      });
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(job.outDir, false);
      if (job.settings.includeReports !== false) {
        archive.file(path.join(job.dir, "report.csv"), { name: "audio_analysis_report.csv" });
        archive.append(JSON.stringify({
          ...job.settings,
          enforcedTargetLufs: REQUIRED_TARGET_LUFS,
          enforcedToleranceLu: REQUIRED_TOLERANCE_LU,
          enforcedTruePeakDbtp: REQUIRED_TRUE_PEAK_DBTP,
          export: job.exportSettings,
        }, null, 2), { name: "processing_settings.json" });
      }
      Promise.resolve(archive.finalize()).catch(reject);
    });
    return;
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  // Dependency-free fallback for recovery/test environments. The production
  // image includes both archiver and the zip utility.
  await execFileP("zip", ["-q", "-r", zipPath, "."], { cwd: job.outDir });
  if (job.settings.includeReports !== false) {
    const reportAlias = path.join(job.dir, "audio_analysis_report.csv");
    const settingsPath = path.join(job.dir, "processing_settings.json");
    await fs.copyFile(path.join(job.dir, "report.csv"), reportAlias);
    await fs.writeFile(settingsPath, JSON.stringify({
      ...job.settings,
      enforcedTargetLufs: REQUIRED_TARGET_LUFS,
      enforcedToleranceLu: REQUIRED_TOLERANCE_LU,
      enforcedTruePeakDbtp: REQUIRED_TRUE_PEAK_DBTP,
      export: job.exportSettings,
    }, null, 2));
    try {
      await execFileP("zip", ["-q", "-j", zipPath, reportAlias, settingsPath]);
    } finally {
      await Promise.all([
        fs.rm(reportAlias, { force: true }),
        fs.rm(settingsPath, { force: true }),
      ]);
    }
  }
}

function successReportRow(file, original, final, pass1, result) {
  return [
    file.sequence,
    file.name,
    file.folder ?? "",
    original.duration?.toFixed(3) ?? "",
    original.lufs?.toFixed(2) ?? "",
    original.lra?.toFixed(2) ?? "",
    original.truePeak?.toFixed(2) ?? "",
    original.bitrate ?? "",
    original.sampleRate ?? "",
    original.channels ?? "",
    pass1?.input_i ?? "",
    pass1?.input_lra ?? "",
    pass1?.input_tp ?? "",
    pass1?.input_thresh ?? "",
    pass1?.target_offset ?? "",
    result.preconditioningGainDb?.toFixed(3) ?? "0.000",
    final.lufs?.toFixed(2) ?? "",
    result.loudnessDeviation?.toFixed(3) ?? "",
    final.truePeak?.toFixed(2) ?? "",
    final.duration?.toFixed(3) ?? "",
    result.bitrate ?? "",
    result.sampleRate ?? "",
    result.channels ?? "",
    result.attempts,
    "passed",
    "",
  ];
}

function failedReportRow(file, error) {
  return [
    file.sequence,
    file.name,
    file.folder ?? "",
    "", "", "", "", "", "", "",
    "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "failed",
    error,
  ];
}

export async function runJob(job, log) {
  const { workerCount, limiter } = await limiterPromise;
  const included = job.files
    .filter((file) => !file.excluded && job.fileMap.has(file.id))
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const total = included.length;
  job.exportSettings = resolveExportSettings(job.settings);
  job.status = "processing";

  const reportRows = new Array(total);
  const failures = new Array(total);
  const active = new Map();
  let nextIndex = 0;
  let completed = 0;
  let failed = 0;
  const startedAt = Date.now();

  const emitProgress = (patch = {}) => {
    const finished = completed + failed;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const rate = finished / elapsedSeconds;
    const remaining = Math.max(0, total - finished);
    job.progress = {
      ...job.progress,
      stage: job.status,
      completed,
      failed,
      total,
      processing: active.size,
      currentlyProcessing: [...active.values()],
      current: [...active.values()][0] ?? null,
      overallPct: total === 0 ? 100 : Math.round((finished / total) * 100),
      etaSeconds: rate > 0 ? Math.ceil(remaining / rate) : null,
      workerCount,
      ...patch,
    };
    job.emit("progress", job.progress);
  };

  emitProgress();

  async function processIndex(index) {
    const file = included[index];
    const displayName = file.folder ? `${file.folder}/${file.name}` : file.name;
    active.set(file.id, displayName);
    emitProgress();
    try {
      const processed = await limiter.run(
        () => processFile({ job, file, log }),
        { signal: job.abortController.signal },
      );
      completed += 1;
      const event = { id: file.id, result: processed.result };
      job.fileResults.push(event);
      job.emit("file", event);
      reportRows[index] = successReportRow(
        file,
        processed.originalAnalysis,
        processed.finalAnalysis,
        processed.pass1Measurement,
        processed.result,
      );
    } catch (error) {
      const message = error?.message ?? String(error);
      failed += 1;
      failures[index] = { name: displayName, error: message };
      const event = { id: file.id, result: { error: message, verificationPassed: false } };
      job.fileResults.push(event);
      job.emit("file", event);
      reportRows[index] = failedReportRow(file, message);
      if (error?.name !== "AbortError") log.error?.({ error, jobId: job.id, file: displayName }, "file failed");
    } finally {
      active.delete(file.id);
      emitProgress();
    }
  }

  async function workerLoop() {
    while (!job.cancelled) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      await processIndex(index);
    }
  }

  const localWorkers = Math.min(workerCount, Math.max(1, total));
  await Promise.all(Array.from({ length: localWorkers }, () => workerLoop()));

  if (job.cancelled || job.abortController.signal.aborted) {
    job.status = "cancelled";
    emitProgress({ stage: "cancelled", message: "cancelled", etaSeconds: 0 });
    await writeReport(job, reportRows.filter(Boolean));
    finishJob(job, { status: "cancelled", success: false, error: "job cancelled" });
    return;
  }

  job.status = "packaging";
  emitProgress({ stage: "packaging", overallPct: 100, etaSeconds: 0 });
  await writeReport(job, reportRows.filter(Boolean));

  if (failures.some(Boolean)) {
    await fs.rm(path.join(job.dir, "result.zip"), { force: true }).catch(() => {});
    job.status = "failed";
    const error = `${failed} of ${total} files failed processing or strict loudness verification`;
    emitProgress({ stage: "failed", message: error, overallPct: 100, etaSeconds: 0 });
    finishJob(job, { status: "failed", success: false, error });
    return;
  }

  await packageZip(job);
  job.status = "ready";
  emitProgress({ stage: "ready", overallPct: 100, etaSeconds: 0 });
  finishJob(job, { status: "ready", success: true });
}
