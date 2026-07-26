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
  const preset = overrides?.preset ?? settings.preset ?? "original";
  const speed = overrides?.speed ?? settings.speed ?? 1;
  const chain = [];

  if ((s.noiseReduction ?? 0) > 0.05) {
    chain.push(`afftdn=nr=${Math.round(s.noiseReduction * 24)}`);
  }
  if (s.highPass && s.highPass > 20) chain.push(`highpass=f=${s.highPass}`);
  if (s.lowPass && s.lowPass < 20000) chain.push(`lowpass=f=${s.lowPass}`);

  chain.push(...(PRESET_CHAINS[preset] ?? []));

  if ((s.deesserStrength ?? 0) > 0.1) {
    // Simple de-esser approximation via bandstop
    chain.push(`equalizer=f=6500:t=q:w=1.5:g=${-(s.deesserStrength * 6).toFixed(2)}`);
  }

  if (s.speedBeforeEnhance) {
    chain.unshift(...atempoChain(speed));
  } else {
    chain.push(...atempoChain(speed));
  }

  if (s.compressionRatio && s.compressionRatio > 1) {
    chain.push(
      `acompressor=threshold=${s.compressionThreshold ?? -20}dB:ratio=${s.compressionRatio}:attack=${s.attack ?? 10}:release=${s.release ?? 120}:makeup=${s.makeupGain ?? 0}`,
    );
  }

  return chain;
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
  if (measured) {
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
    : "192k";
  const sr = settings.outputSampleRate && settings.outputSampleRate !== "preserve"
    ? String(settings.outputSampleRate)
    : "44100";
  const channels =
    settings.outputChannels === "mono" ? "1" :
    settings.outputChannels === "stereo" ? "2" : "2";

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

  // Verify
  let finalAnalysis = null;
  let verificationPassed = true;
  if (settings.verifyOutput !== false) {
    finalAnalysis = await analyzeMp3(outAbs).catch(() => null);
    const tol = settings.verificationTolerance ?? 1.0;
    if (
      finalAnalysis?.lufs != null &&
      Math.abs(finalAnalysis.lufs - targetLufs) > tol
    ) {
      // Retry with dynamic loudnorm
      log.warn?.(
        { id: file.id, measured: finalAnalysis.lufs, target: targetLufs },
        "verification miss — retrying with linear=false",
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
      verificationPassed =
        finalAnalysis?.lufs != null &&
        Math.abs(finalAnalysis.lufs - targetLufs) <= tol * 1.5;
    }
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
