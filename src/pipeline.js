import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { runFfmpeg, parseLoudnormJson, analyzeMp3 } from "./ffmpeg.js";

const TARGET_LUFS = -16;
const TRUE_PEAK_CEILING = -1.5;
const VERIFY_TOLERANCE = 0.3;
const DEFAULT_OUTPUT_BITRATE = 192000;
const DEFAULT_OUTPUT_SAMPLE_RATE = 48000;
const DEFAULT_OUTPUT_CHANNELS = 2;

const PRESET_CHAINS = {
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
};

function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function atempoChain(speed) {
  const s = finiteNumber(speed, 1, 0.25, 4);
  if (s === 1) return [];
  const parts = [];
  let remaining = s;
  while (remaining > 2.0) {
    parts.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts;
}

function buildProcessingFilters(settings, overrides, originalDuration) {
  const s = { ...settings, ...(overrides ?? {}) };
  const mode = s.mode ?? "normalize_enhance";
  const preset = overrides?.preset ?? settings.preset ?? "original";
  const speed = finiteNumber(overrides?.speed ?? settings.speed, 1, 0.25, 4);
  const chain = [];

  if (s.silenceTrim) {
    chain.push("silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:stop_periods=-1:stop_duration=0.2:stop_threshold=-50dB");
  }

  if (mode !== "normalize") {
    const noiseReduction = finiteNumber(s.noiseReduction, 0, 0, 1);
    if (noiseReduction > 0.05) {
      chain.push(`afftdn=nr=${Math.round(noiseReduction * 24)}`);
    }
    const highPass = finiteNumber(s.highPass, 0, 0, 1000);
    const lowPass = finiteNumber(s.lowPass, 0, 1000, 22050);
    if (highPass > 20) chain.push(`highpass=f=${highPass}`);
    if (lowPass >= 1000 && lowPass < 20000) chain.push(`lowpass=f=${lowPass}`);

    chain.push(...(PRESET_CHAINS[preset] ?? []));

    const bass = finiteNumber(s.bass, 0, -12, 12);
    const mid = finiteNumber(s.mid, 0, -12, 12);
    const treble = finiteNumber(s.treble, 0, -12, 12);
    const presence = finiteNumber(s.presence, 0, -12, 12);
    if (bass !== 0) chain.push(`equalizer=f=120:t=q:w=1:g=${bass.toFixed(2)}`);
    if (mid !== 0) chain.push(`equalizer=f=1000:t=q:w=1:g=${mid.toFixed(2)}`);
    if (treble !== 0) chain.push(`equalizer=f=8000:t=q:w=1:g=${treble.toFixed(2)}`);
    if (presence !== 0) chain.push(`equalizer=f=3500:t=q:w=1:g=${presence.toFixed(2)}`);

    const deesserStrength = finiteNumber(s.deesserStrength, 0, 0, 1);
    if (deesserStrength > 0.1) {
      // Simple de-esser approximation via bandstop
      chain.push(`equalizer=f=6500:t=q:w=1.5:g=${-(deesserStrength * 6).toFixed(2)}`);
    }
  }

  if (s.speedBeforeEnhance) {
    chain.unshift(...atempoChain(speed));
  } else {
    chain.push(...atempoChain(speed));
  }

  const compressionRatio = finiteNumber(s.compressionRatio, 1, 1, 20);
  if (mode !== "normalize" && compressionRatio > 1) {
    // FFmpeg acompressor's makeup value is a linear multiplier with valid range 1..64.
    // The UI uses 0 dB as "no makeup", so convert dB to a safe multiplier.
    const makeupDb = finiteNumber(s.makeupGain, 0, -24, 24);
    const makeup = Math.max(1, Math.min(64, Math.pow(10, makeupDb / 20)));
    chain.push(
      `acompressor=threshold=${finiteNumber(s.compressionThreshold, -20, -80, 0)}dB:ratio=${compressionRatio}:attack=${finiteNumber(s.attack, 10, 0.01, 2000)}:release=${finiteNumber(s.release, 120, 1, 5000)}:makeup=${makeup.toFixed(4)}`,
    );
  }

  const fadeIn = finiteNumber(s.fadeIn, 0, 0, 30);
  const fadeOut = finiteNumber(s.fadeOut, 0, 0, 30);
  if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
  if (fadeOut > 0 && Number.isFinite(originalDuration) && originalDuration > 0) {
    const adjustedDuration = originalDuration / speed;
    chain.push(`afade=t=out:st=${Math.max(0, adjustedDuration - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`);
  }

  return chain;
}

function hasUsableLoudnormMeasurement(measured) {
  return Boolean(
    measured &&
    Number.isFinite(Number(measured.input_i)) &&
    Number.isFinite(Number(measured.input_lra)) &&
    Number.isFinite(Number(measured.input_tp)) &&
    Number.isFinite(Number(measured.input_thresh)) &&
    Number.isFinite(Number(measured.target_offset))
  );
}

function requireLoudnormMeasurement(measured, label) {
  if (!hasUsableLoudnormMeasurement(measured)) {
    throw new Error(`${label} loudnorm measurement failed`);
  }
  return measured;
}

function safeOutputRelativePath(file, renameFiles) {
  const originalName = String(file.name ?? "audio.mp3").replaceAll("\\", "/").split("/").pop() || "audio.mp3";
  const outputName = renameFiles
    ? `${String(file.sequence ?? 0).padStart(4, "0")}_${originalName}`
    : originalName;
  const raw = [file.folder, outputName]
    .filter(Boolean)
    .join("/")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  const clean = path.posix.normalize(raw);
  if (!clean || clean === "." || clean.startsWith("../") || path.posix.isAbsolute(clean)) {
    throw new Error(`unsafe output path: ${file.folder ? `${file.folder}/` : ""}${file.name}`);
  }
  return clean;
}

function outputPathInside(outDir, outRel) {
  const resolved = path.resolve(outDir, ...outRel.split("/"));
  const root = path.resolve(outDir) + path.sep;
  if (!resolved.startsWith(root)) throw new Error(`unsafe output path: ${outRel}`);
  return resolved;
}

function getOutputEncoding(settings) {
  const bitrateValue = settings.outputBitrate && settings.outputBitrate !== "preserve"
    ? finiteNumber(settings.outputBitrate, DEFAULT_OUTPUT_BITRATE, 64000, 320000)
    : DEFAULT_OUTPUT_BITRATE;
  const sampleRateValue = settings.outputSampleRate && settings.outputSampleRate !== "preserve"
    ? finiteNumber(settings.outputSampleRate, DEFAULT_OUTPUT_SAMPLE_RATE, 8000, 48000)
    : DEFAULT_OUTPUT_SAMPLE_RATE;
  const channelsValue = settings.outputChannels === "mono" ? 1 : settings.outputChannels === "preserve" ? DEFAULT_OUTPUT_CHANNELS : 2;
  return {
    bitrate: `${Math.round(bitrateValue / 1000)}k`,
    sampleRate: String(Math.round(sampleRateValue)),
    channels: String(channelsValue),
  };
}

function measuredLoudnormFilter({ targetLufs, lra, tp, measured, linear }) {
  return `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}` +
    `:measured_I=${measured.input_i}` +
    `:measured_LRA=${measured.input_lra}` +
    `:measured_TP=${measured.input_tp}` +
    `:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}` +
    `:linear=${linear ? "true" : "false"}:print_format=summary`;
}

async function measureLoudness(inPath, targetLufs, tp, lra) {
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-i", inPath,
    "-af",
    `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}:print_format=json`,
    "-f", "null",
    "-",
  ]);
  return parseLoudnormJson(stderr);
}

function ffmpegOptions(job) {
  return {
    signal: job.abortController?.signal,
    onChild: (child) => {
      job.activeChild = child;
    },
  };
}

async function measureJobLoudness(job, inPath, targetLufs, tp, lra) {
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-i", inPath,
    "-af",
    `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}:print_format=json`,
    "-f", "null",
    "-",
  ], ffmpegOptions(job));
  return parseLoudnormJson(stderr);
}

async function encodeNormalized({ job, stagedWav, outAbs, measured, targetLufs, lra, tp, encoding, linear }) {
  const filters = [
    measuredLoudnormFilter({ targetLufs, lra, tp, measured, linear }),
  ];
  await runFfmpeg([
    "-hide_banner", "-y",
    "-i", stagedWav,
    "-af", filters.join(","),
    "-ar", encoding.sampleRate,
    "-ac", encoding.channels,
    "-c:a", "libmp3lame",
    "-b:a", encoding.bitrate,
    outAbs,
  ], ffmpegOptions(job));
}

function verifyAnalysis(analysis, targetLufs, tp) {
  const errors = [];
  const lufs = Number(analysis?.lufs);
  const truePeak = Number(analysis?.truePeak);
  if (!analysis) errors.push("verification analysis failed");
  if (!Number.isFinite(lufs)) errors.push("integrated loudness is unmeasurable");
  else if (Math.abs(lufs - targetLufs) > VERIFY_TOLERANCE) {
    errors.push(`integrated loudness ${lufs.toFixed(2)} LUFS is outside ${targetLufs} ±${VERIFY_TOLERANCE}`);
  }
  if (!Number.isFinite(truePeak)) errors.push("true peak is unmeasurable");
  else if (truePeak > tp) errors.push(`true peak ${truePeak.toFixed(2)} dBTP is above ${tp} dBTP`);
  return { passed: errors.length === 0, errors };
}

async function processFile({ job, file, log }) {
  const settings = job.settings;
  const overrides = file.overrides ?? {};
  const inPath = job.fileMap.get(file.id);
  if (!inPath) throw new Error("input file missing");

  const targetLufs = TARGET_LUFS;
  const tp = TRUE_PEAK_CEILING;
  const lra = finiteNumber(settings.loudnessRange, 7, 1, 20);

  const originalAnalysis = await analyzeMp3(inPath, ffmpegOptions(job)).catch(() => null);
  if (originalAnalysis?.classification === "corrupted") {
    throw new Error(originalAnalysis.error ?? "file is not decodable audio");
  }

  const preFilters = buildProcessingFilters(settings, overrides, originalAnalysis?.duration);

  const stageDir = path.join(job.dir, `stage_${file.id}`);
  await fs.mkdir(stageDir, { recursive: true });
  let stagedWav = path.join(stageDir, "staged.wav");
  const outRel = safeOutputRelativePath(file, settings.renameFiles === true);
  const outAbs = outputPathInside(job.outDir, outRel);
  const altAbs = path.join(stageDir, "alt.mp3");
  const encoding = getOutputEncoding(settings);
  const warnings = [];
  let limiterApplied = false;
  let preGainDb = 0;

  try {
    // Stage: enhancement + speed + a safety limiter BEFORE normalization so
    // clipping never causes a rejection and never shifts final loudness.
    const stageChain = [...preFilters, "alimiter=limit=0.891:level=false"];
    limiterApplied = true;
    await runFfmpeg([
      "-hide_banner", "-y",
      "-i", inPath,
      "-af", stageChain.join(","),
      "-ar", encoding.sampleRate,
      "-ac", encoding.channels,
      stagedWav,
    ], ffmpegOptions(job));

    // Pass 1: measure enhanced audio.
    let measured = await measureJobLoudness(job, stagedWav, targetLufs, tp, lra);

    // Extremely quiet sources can fall below the R128 gate: pre-gain, then re-measure.
    const measuredI = Number(measured?.input_i);
    if (!hasUsableLoudnormMeasurement(measured) || !Number.isFinite(measuredI) || measuredI < -40) {
      preGainDb = Number.isFinite(measuredI) ? Math.min(60, Math.max(0, -24 - measuredI)) : 30;
      const boosted = path.join(stageDir, "boosted.wav");
      await runFfmpeg([
        "-hide_banner", "-y",
        "-i", stagedWav,
        "-af", `volume=${preGainDb.toFixed(2)}dB,alimiter=limit=0.891:level=false`,
        "-ar", encoding.sampleRate,
        "-ac", encoding.channels,
        boosted,
      ], ffmpegOptions(job));
      await fs.rm(stagedWav, { force: true }).catch(() => {});
      stagedWav = boosted;
      measured = await measureJobLoudness(job, stagedWav, targetLufs, tp, lra);
      warnings.push(`pre-gain ${preGainDb.toFixed(1)} dB applied to very quiet source`);
    }

    await fs.mkdir(path.dirname(outAbs), { recursive: true });

    const scoreOf = (a) => {
      const l = Number(a?.lufs);
      if (!Number.isFinite(l)) return Number.POSITIVE_INFINITY;
      return Math.abs(l - targetLufs);
    };

    let finalAnalysis = null;

    if (hasUsableLoudnormMeasurement(measured)) {
      // Pass 2: true two-pass EBU R128 with measured values.
      await encodeNormalized({ job, stagedWav, outAbs, measured, targetLufs, lra, tp, encoding, linear: true });
      finalAnalysis = await analyzeMp3(outAbs, ffmpegOptions(job)).catch(() => null);

      if (!verifyAnalysis(finalAnalysis, targetLufs, tp).passed) {
        // Try the dynamic pass and keep whichever result is closest to target.
        await encodeNormalized({ job, stagedWav, outAbs: altAbs, measured, targetLufs, lra, tp, encoding, linear: false });
        const altAnalysis = await analyzeMp3(altAbs, ffmpegOptions(job)).catch(() => null);
        if (scoreOf(altAnalysis) < scoreOf(finalAnalysis)) {
          await fs.rename(altAbs, outAbs).catch(async () => {
            await fs.copyFile(altAbs, outAbs);
          });
          finalAnalysis = altAnalysis;
        }
      }
    } else {
      // Measurement unusable: still deliver a normalized best effort.
      warnings.push("loudnorm measurement unavailable — single-pass fallback used");
      await runFfmpeg([
        "-hide_banner", "-y",
        "-i", stagedWav,
        "-af", `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}`,
        "-ar", encoding.sampleRate,
        "-ac", encoding.channels,
        "-c:a", "libmp3lame",
        "-b:a", encoding.bitrate,
        outAbs,
      ], ffmpegOptions(job));
      finalAnalysis = await analyzeMp3(outAbs, ffmpegOptions(job)).catch(() => null);
    }

    const verification = verifyAnalysis(finalAnalysis, targetLufs, tp);
    if (!verification.passed) {
      warnings.push(...verification.errors);
      log.warn?.({ id: file.id, errors: verification.errors }, "kept best-effort output outside tolerance");
    }

    const outStat = await fs.stat(outAbs).catch(() => null);
    if (!outStat) throw new Error("output file was not produced");

    return {
      outRel,
      originalAnalysis,
      finalAnalysis,
      warnings,
      limiterApplied,
      preGainDb,
      result: {
        finalLufs: finalAnalysis?.lufs,
        finalTruePeak: finalAnalysis?.truePeak,
        finalDuration: finalAnalysis?.duration,
        outputSize: outStat.size,
        verificationPassed: verification.passed,
        warnings,
      },
    };
  } catch (err) {
    await fs.rm(outAbs, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function writeReport(job, rows, jsonRows) {
  const header = [
    "sequence", "original_filename", "folder_path", "duration",
    "original_lufs", "original_true_peak", "original_lra",
    "original_bitrate", "original_sample_rate", "original_status",
    "applied_speed", "applied_preset",
    "final_lufs", "final_true_peak", "final_duration", "final_bitrate",
    "limiter_applied", "pre_gain_db", "within_tolerance",
    "processing_status", "warnings", "error_message",
  ];
  const lines = [header.join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  await fs.writeFile(path.join(job.dir, "report.csv"), lines.join("\n"));
  await fs.writeFile(path.join(job.dir, "report.json"), JSON.stringify(jsonRows, null, 2));
}

async function packageZip(job, failed) {
  const zipPath = path.join(job.dir, "result.zip");
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(job.outDir, false);
    if (job.settings.includeReports !== false) {
      archive.file(path.join(job.dir, "report.csv"), { name: "audio_analysis_report.csv" });
      archive.file(path.join(job.dir, "report.json"), { name: "audio_analysis_report.json" });
      archive.append(JSON.stringify(job.settings, null, 2), { name: "processing_settings.txt" });
    }
    if (failed.length > 0) {
      archive.append(
        failed.map((f) => `${f.name}\t${f.error}`).join("\n"),
        { name: "failed_files.txt" },
      );
    }
    archive.finalize();
  });
}

export async function runJob(job, log) {
  const included = job.files
    .filter((f) => !f.excluded && job.fileMap.has(f.id))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const total = included.length;

  const emitProgress = (patch) => {
    job.progress = { ...job.progress, ...patch };
    job.emit("progress", job.progress);
  };

  if (total === 0) {
    emitProgress({ stage: "failed", overallPct: 0, completed: 0, failed: 0, total: 0, message: "no included files uploaded" });
    job.done = true;
    job.emit("done");
    return;
  }

  emitProgress({ stage: "processing", overallPct: 0, completed: 0, failed: 0, total });

  const reportRows = [];
  const jsonRows = [];
  const failed = [];
  let completed = 0;
  let failCount = 0;

  for (const file of included) {
    if (job.cancelled) {
      emitProgress({ stage: "failed", message: "cancelled" });
      return;
    }
    emitProgress({
      stage: "processing",
      current: file.folder ? `${file.folder}/${file.name}` : file.name,
    });
    const speed = file.overrides?.speed ?? job.settings.speed ?? 1;
    const preset = file.overrides?.preset ?? job.settings.preset ?? "original";
    try {
      const { originalAnalysis, finalAnalysis, result, warnings, limiterApplied, preGainDb } =
        await processFile({ job, file, log });
      completed++;
      job.fileResults.push({ id: file.id, result });
      job.emit("file", { id: file.id, result });
      const status = result.verificationPassed ? "ok" : "best_effort";
      reportRows.push([
        file.sequence,
        file.name,
        file.folder ?? "",
        originalAnalysis?.duration?.toFixed(2) ?? "",
        originalAnalysis?.lufs?.toFixed(2) ?? "",
        originalAnalysis?.truePeak?.toFixed(2) ?? "",
        originalAnalysis?.lra?.toFixed(2) ?? "",
        originalAnalysis?.bitrate ?? "",
        originalAnalysis?.sampleRate ?? "",
        originalAnalysis?.classification ?? "",
        speed,
        preset,
        finalAnalysis?.lufs?.toFixed(2) ?? "",
        finalAnalysis?.truePeak?.toFixed(2) ?? "",
        finalAnalysis?.duration?.toFixed(2) ?? "",
        finalAnalysis?.bitrate ?? "",
        limiterApplied ? "yes" : "no",
        (preGainDb ?? 0).toFixed(2),
        result.verificationPassed ? "yes" : "no",
        status,
        (warnings ?? []).join(" | "),
        "",
      ]);
      jsonRows.push({
        sequence: file.sequence,
        filename: file.name,
        folder: file.folder ?? "",
        status,
        originalLufs: originalAnalysis?.lufs ?? null,
        finalLufs: finalAnalysis?.lufs ?? null,
        originalTruePeak: originalAnalysis?.truePeak ?? null,
        finalTruePeak: finalAnalysis?.truePeak ?? null,
        limiterApplied: Boolean(limiterApplied),
        preGainDb: preGainDb ?? 0,
        withinTolerance: Boolean(result.verificationPassed),
        warnings: warnings ?? [],
        error: null,
      });
    } catch (err) {
      failCount++;
      const msg = err.message ?? String(err);
      log.error?.({ err, file: file.name }, "file failed");
      failed.push({ name: file.name, error: msg });
      job.fileResults.push({ id: file.id, result: { error: msg, verificationPassed: false } });
      job.emit("file", { id: file.id, result: { error: msg, verificationPassed: false } });
      reportRows.push([
        file.sequence, file.name, file.folder ?? "",
        "", "", "", "", "", "", "",
        speed, preset,
        "", "", "", "", "no", "0.00", "no", "failed", "", msg,
      ]);
      jsonRows.push({
        sequence: file.sequence,
        filename: file.name,
        folder: file.folder ?? "",
        status: "failed",
        originalLufs: null,
        finalLufs: null,
        originalTruePeak: null,
        finalTruePeak: null,
        limiterApplied: false,
        preGainDb: 0,
        withinTolerance: false,
        warnings: [],
        error: msg,
      });
    }
    emitProgress({
      completed,
      failed: failCount,
      overallPct: Math.round(((completed + failCount) / total) * 100),
    });
  }

  emitProgress({ stage: "packaging", overallPct: 100 });
  await writeReport(job, reportRows, jsonRows);
  await packageZip(job, failed);
  emitProgress({ stage: "ready", overallPct: 100 });
  job.done = true;
  job.emit("done");
}
