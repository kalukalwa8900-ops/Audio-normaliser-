import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { runFfmpeg, parseLoudnormJson, analyzeMp3 } from "./ffmpeg.js";

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

function atempoChain(speed) {
  const s = Math.max(0.25, Math.min(4, Number(speed) || 1));
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

function buildProcessingFilters(settings, overrides) {
  const s = { ...settings, ...(overrides ?? {}) };
  const mode = s.mode ?? "normalize_enhance";
  const preset = overrides?.preset ?? settings.preset ?? "original";
  const speed = overrides?.speed ?? settings.speed ?? 1;
  const chain = [];

  if (mode !== "normalize") {
    if ((s.noiseReduction ?? 0) > 0.05) {
      chain.push(`afftdn=nr=${Math.round(s.noiseReduction * 24)}`);
    }
    if (s.highPass && s.highPass > 20) chain.push(`highpass=f=${s.highPass}`);
    if (s.lowPass && s.lowPass < 20000) chain.push(`lowpass=f=${s.lowPass}`);

    chain.push(...(PRESET_CHAINS[preset] ?? []));

    if ((s.bass ?? 0) !== 0) chain.push(`equalizer=f=120:t=q:w=1:g=${Number(s.bass).toFixed(2)}`);
    if ((s.mid ?? 0) !== 0) chain.push(`equalizer=f=1000:t=q:w=1:g=${Number(s.mid).toFixed(2)}`);
    if ((s.treble ?? 0) !== 0) chain.push(`equalizer=f=8000:t=q:w=1:g=${Number(s.treble).toFixed(2)}`);
    if ((s.presence ?? 0) !== 0) chain.push(`equalizer=f=3500:t=q:w=1:g=${Number(s.presence).toFixed(2)}`);

    if ((s.deesserStrength ?? 0) > 0.1) {
      // Simple de-esser approximation via bandstop
      chain.push(`equalizer=f=6500:t=q:w=1.5:g=${-(s.deesserStrength * 6).toFixed(2)}`);
    }
  }

  if (s.speedBeforeEnhance) {
    chain.unshift(...atempoChain(speed));
  } else {
    chain.push(...atempoChain(speed));
  }

  if (mode !== "normalize" && s.compressionRatio && s.compressionRatio > 1) {
    // FFmpeg acompressor's makeup value is a linear multiplier with valid range 1..64.
    // The UI uses 0 dB as "no makeup", so convert dB to a safe multiplier.
    const makeupDb = Number(s.makeupGain ?? 0);
    const makeup = Math.max(1, Math.min(64, Math.pow(10, makeupDb / 20)));
    chain.push(
      `acompressor=threshold=${s.compressionThreshold ?? -20}dB:ratio=${s.compressionRatio}:attack=${s.attack ?? 10}:release=${s.release ?? 120}:makeup=${makeup.toFixed(4)}`,
    );
  }

  if ((s.fadeIn ?? 0) > 0) chain.push(`afade=t=in:st=0:d=${Number(s.fadeIn).toFixed(2)}`);

  return chain;
}

function finiteMeasurementValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasUsableLoudnormMeasurement(measured) {
  return Boolean(
    measured &&
    finiteMeasurementValue(measured.input_i) != null &&
    finiteMeasurementValue(measured.input_lra) != null &&
    finiteMeasurementValue(measured.input_tp) != null &&
    finiteMeasurementValue(measured.input_thresh) != null &&
    finiteMeasurementValue(measured.target_offset) != null
  );
}

// Hard floor: below these, normalized speech is not usably audible even if the
// LUFS math checks out (a file with a few loud transients but mostly quiet
// speech can average out to a "correct" integrated LUFS while sounding
// whisper-quiet). This floor is NOT configurable via job settings.
const HARD_MIN_MAX_PEAK_DB = -18;
const HARD_MIN_RMS_DB = -30;

function outputLooksAudible(analysis, targetLufs, tolerance) {
  if (!analysis) return false;
  const lufs = finiteMeasurementValue(analysis.lufs);
  const maxPeak = finiteMeasurementValue(analysis.maxPeak);
  const rms = finiteMeasurementValue(analysis.rms);

  // A normalized spoken-word file should always have a measurable loudness and
  // should not have peaks/RMS at near-silence levels. These guards prevent an
  // FFmpeg success exit code from being mistaken for a healthy audio result.
  if (lufs == null) return false;
  if (Math.abs(lufs - targetLufs) > tolerance) return false;
  if (maxPeak != null && maxPeak < HARD_MIN_MAX_PEAK_DB) return false;
  if (rms != null && rms < HARD_MIN_RMS_DB) return false;
  return true;
}

// Independent of settings.verifyOutput / tolerance — the absolute floor that
// decides whether a file is audible at all. verifyOutput:false only skips the
// LUFS-target comparison in outputLooksAudible, never this check.
function outputIsHardSilent(analysis) {
  if (!analysis) return true;
  const maxPeak = finiteMeasurementValue(analysis.maxPeak);
  const rms = finiteMeasurementValue(analysis.rms);
  if (maxPeak != null && maxPeak < HARD_MIN_MAX_PEAK_DB) return true;
  if (rms != null && rms < HARD_MIN_RMS_DB) return true;
  return false;
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

async function processFile({ job, file, log }) {
  const settings = job.settings;
  const overrides = file.overrides ?? {};
  const inPath = job.fileMap.get(file.id);
  if (!inPath) throw new Error("input file missing");

  const targetLufs = overrides.targetLufs ?? settings.targetLufs ?? -16;
  const tp = settings.truePeak ?? -1.5;
  const lra = settings.loudnessRange ?? 7;

  // Pre-analysis for report
  const originalAnalysis = await analyzeMp3(inPath).catch(() => null);

  const preFilters = buildProcessingFilters(settings, overrides);

  // Intermediate WAV so loudnorm two-pass can measure post-enhancement audio.
  const stageDir = path.join(job.dir, `stage_${file.id}`);
  await fs.mkdir(stageDir, { recursive: true });
  const stagedWav = path.join(stageDir, "staged.wav");

  const stageArgs = [
    "-hide_banner", "-y",
    "-i", inPath,
  ];
  if (preFilters.length > 0) {
    stageArgs.push("-af", preFilters.join(","));
  }
  stageArgs.push("-ar", "48000", "-ac", "2", stagedWav);
  await runFfmpeg(stageArgs);

  // Pass 1: measure
  const measured = await measureLoudness(stagedWav, targetLufs, tp, lra);
  const limiterCeiling = tp;

  // Pass 2: apply
  const outRel = file.folder
    ? path.join(file.folder, file.name)
    : file.name;
  const outAbs = path.join(job.outDir, outRel);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });

  const applyFilters = [];
  if (hasUsableLoudnormMeasurement(measured)) {
    applyFilters.push(
      `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}` +
        `:measured_I=${measured.input_i}` +
        `:measured_LRA=${measured.input_lra}` +
        `:measured_TP=${measured.input_tp}` +
        `:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}` +
        `:linear=true:print_format=summary`,
    );
  } else {
    applyFilters.push(`loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}`);
  }
  applyFilters.push(`alimiter=limit=${limiterCeiling}dB`);

  const bitrate = settings.outputBitrate && settings.outputBitrate !== "preserve"
    ? `${settings.outputBitrate / 1000}k`
    : originalAnalysis?.bitrate
      ? `${Math.max(64, Math.min(320, Math.round(originalAnalysis.bitrate / 1000)))}k`
      : "192k";
  const sr = settings.outputSampleRate && settings.outputSampleRate !== "preserve"
    ? String(settings.outputSampleRate)
    : String(originalAnalysis?.sampleRate ?? 44100);
  const channels =
    settings.outputChannels === "mono" ? "1" :
    settings.outputChannels === "stereo" ? "2" : String(originalAnalysis?.channels ?? 2);

  const applyArgs = [
    "-hide_banner", "-y",
    "-i", stagedWav,
    "-af", applyFilters.join(","),
    "-ar", sr,
    "-ac", channels,
    "-c:a", "libmp3lame",
    "-b:a", bitrate,
    outAbs,
  ];
  await runFfmpeg(applyArgs);

  // Verify. A missing LUFS reading or near-silent peak/RMS is a failure too.
  // The LUFS-target comparison can be relaxed via settings.verifyOutput /
  // verificationTolerance, but the hard audibility floor below always runs —
  // it cannot be turned off from job settings, so a misconfigured or stale
  // frontend can never cause a whisper-quiet file to be shipped as "ok".
  let finalAnalysis = await analyzeMp3(outAbs).catch(() => null);
  let verificationPassed = true;
  const verifyLoudnessTarget = settings.verifyOutput !== false;
  const tol = Number(settings.verificationTolerance ?? 1.0);

  verificationPassed = verifyLoudnessTarget
    ? outputLooksAudible(finalAnalysis, targetLufs, tol)
    : !outputIsHardSilent(finalAnalysis);

  if (!verificationPassed) {
    // Retry with dynamic loudnorm. This is safer for very short clips,
    // unusual dynamics, and files where the measured linear pass is invalid.
    log.warn?.(
      {
        id: file.id,
        measured: finalAnalysis?.lufs,
        maxPeak: finalAnalysis?.maxPeak,
        rms: finalAnalysis?.rms,
        target: targetLufs,
      },
      "verification miss or near-silent output — retrying with dynamic loudnorm",
    );
    const retryFilters = [
      `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}:linear=false:print_format=summary`,
      `alimiter=limit=${limiterCeiling}dB`,
    ];
    await runFfmpeg([
      "-hide_banner", "-y",
      "-i", stagedWav,
      "-af", retryFilters.join(","),
      "-ar", sr,
      "-ac", channels,
      "-c:a", "libmp3lame",
      "-b:a", bitrate,
      outAbs,
    ]);
    finalAnalysis = await analyzeMp3(outAbs).catch(() => null);
    verificationPassed = verifyLoudnessTarget
      ? outputLooksAudible(finalAnalysis, targetLufs, tol * 1.5)
      : !outputIsHardSilent(finalAnalysis);
  }

  if (!verificationPassed && outputIsHardSilent(finalAnalysis)) {
    // Last resort: force a straight gain boost off the actually-measured level
    // of the retry output, rather than dropping the file. This is what fixes
    // "some files come out too quiet to hear" — instead of failing the file
    // (which just silently excludes it from the zip), we push its peak up to
    // just under the limiter ceiling so it's audible, even if that means it
    // no longer sits exactly at the target integrated LUFS.
    const measuredPeak = finiteMeasurementValue(finalAnalysis?.maxPeak);
    const headroom = 1.0; // dB below the limiter ceiling / 0dBFS
    const forcedGainDb = measuredPeak != null
      ? Math.min(24, Math.max(0, (limiterCeiling - headroom) - measuredPeak))
      : 18; // no usable measurement at all — apply a large flat boost

    log.warn?.(
      { id: file.id, forcedGainDb, measuredPeak },
      "still inaudible after retry — applying forced gain repair pass",
    );

    const repairFilters = [
      `volume=${forcedGainDb.toFixed(2)}dB`,
      `alimiter=limit=${limiterCeiling}dB`,
    ];
    await runFfmpeg([
      "-hide_banner", "-y",
      "-i", stagedWav,
      "-af", repairFilters.join(","),
      "-ar", sr,
      "-ac", channels,
      "-c:a", "libmp3lame",
      "-b:a", bitrate,
      outAbs,
    ]);
    finalAnalysis = await analyzeMp3(outAbs).catch(() => null);
    verificationPassed = !outputIsHardSilent(finalAnalysis);
  }

  if (!verificationPassed) {
    // Only reaches here if the source itself is genuinely silent/corrupted
    // (forced gain couldn't recover it either) — safer to fail than to ship
    // amplified noise/silence.
    throw new Error(
      `output audio failed loudness safety check (LUFS=${finalAnalysis?.lufs ?? "unmeasurable"}, ` +
      `peak=${finalAnalysis?.maxPeak ?? "unmeasurable"} dB, RMS=${finalAnalysis?.rms ?? "unmeasurable"} dB)`,
    );
  }

  await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});

  const outStat = await fs.stat(outAbs).catch(() => null);
  return {
    outRel,
    originalAnalysis,
    finalAnalysis,
    result: {
      finalLufs: finalAnalysis?.lufs,
      finalTruePeak: finalAnalysis?.truePeak,
      finalDuration: finalAnalysis?.duration,
      outputSize: outStat?.size,
      verificationPassed,
    },
  };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function writeReport(job, rows) {
  const header = [
    "sequence", "original_filename", "folder_path", "duration",
    "original_lufs", "original_true_peak", "original_lra",
    "original_bitrate", "original_sample_rate", "original_status",
    "applied_speed", "applied_preset",
    "final_lufs", "final_true_peak", "final_duration", "final_bitrate",
    "processing_status", "error_message",
  ];
  const lines = [header.join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  await fs.writeFile(path.join(job.dir, "report.csv"), lines.join("\n"));
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

  emitProgress({ stage: "processing", overallPct: 0, completed: 0, failed: 0, total });

  const reportRows = [];
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
    try {
      const { originalAnalysis, finalAnalysis, result } = await processFile({ job, file, log });
      completed++;
      job.fileResults.push({ id: file.id, result });
      job.emit("file", { id: file.id, result });
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
        file.overrides?.speed ?? job.settings.speed ?? 1,
        file.overrides?.preset ?? job.settings.preset ?? "original",
        finalAnalysis?.lufs?.toFixed(2) ?? "",
        finalAnalysis?.truePeak?.toFixed(2) ?? "",
        finalAnalysis?.duration?.toFixed(2) ?? "",
        finalAnalysis?.bitrate ?? "",
        result.verificationPassed ? "ok" : "verification_miss",
        "",
      ]);
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
        file.overrides?.speed ?? job.settings.speed ?? 1,
        file.overrides?.preset ?? job.settings.preset ?? "original",
        "", "", "", "", "failed", msg,
      ]);
    }
    emitProgress({
      completed,
      failed: failCount,
      overallPct: Math.round(((completed + failCount) / total) * 100),
    });
  }

  emitProgress({ stage: "packaging", overallPct: 100 });
  await writeReport(job, reportRows);
  await packageZip(job, failed);
  emitProgress({ stage: "ready", overallPct: 100 });
  job.done = true;
  job.emit("done");
}
