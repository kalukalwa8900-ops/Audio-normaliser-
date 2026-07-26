import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { runFfmpeg, parseLoudnormJson, analyzeMp3 } from "./ffmpeg.js";
import { FFMPEG_WORKERS, ffmpegFileLimit } from "./concurrency.js";

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

  // OPTIMIZATION: Single-pass processing instead of 3 separate FFmpeg invocations
  // Old pipeline: Stage (encode to WAV) → Measure loudness → Apply normalized loudness + limiter
  // New pipeline: Apply all + loudnorm + limiter directly in one pass
  
  const outRel = file.folder
    ? path.join(file.folder, file.name)
    : file.name;
  const outAbs = path.join(job.outDir, outRel);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });

  // Build complete filter chain: enhancements → loudnorm → limiter
  const allFilters = [...preFilters];
  allFilters.push(`loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}:print_format=json`);
  allFilters.push(`alimiter=limit=${tp}dB`);

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

  // Single FFmpeg call: input → filters → loudnorm → limiter → MP3 encode
  const encodeArgs = [
    "-hide_banner", "-y",
    "-i", inPath,
    "-af", allFilters.join(","),
    "-ar", sr,
    "-ac", channels,
    "-c:a", "libmp3lame",
    "-b:a", bitrate,
    outAbs,
  ];
  await runFfmpeg(encodeArgs);

  // Verify output loudness with single analysis
  let finalAnalysis = null;
  let verificationPassed = true;
  if (settings.verifyOutput !== false) {
    finalAnalysis = await analyzeMp3(outAbs).catch(() => null);
    const tol = settings.verificationTolerance ?? 1.0;
    if (
      finalAnalysis?.lufs != null &&
      Math.abs(finalAnalysis.lufs - targetLufs) > tol
    ) {
      // If verification fails, retry with dynamic loudnorm (second pass only)
      log.warn?.(
        { id: file.id, measured: finalAnalysis.lufs, target: targetLufs },
        "verification miss — retrying with dynamic loudnorm",
      );
      const retryFilters = [
        ...preFilters,
        `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${tp}:linear=false:print_format=summary`,
        `alimiter=limit=${tp}dB`,
      ];
      await runFfmpeg([
        "-hide_banner", "-y",
        "-i", inPath,
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

  emitProgress({
    stage: "processing",
    overallPct: 0,
    completed: 0,
    failed: 0,
    processing: 0,
    currentlyProcessing: [],
    total,
    workerCount: FFMPEG_WORKERS,
  });

  const reportRows = new Array(total);
  const failedByIndex = new Array(total);
  let completed = 0;
  let failCount = 0;
  let nextIndex = 0;
  const active = new Map();
  const startedAt = Date.now();

  const updateProgress = () => {
    const finished = completed + failCount;
    const elapsedMs = Date.now() - startedAt;
    const rate = finished > 0 ? finished / Math.max(1, elapsedMs) : 0;
    const remaining = total - finished;
    const etaSeconds = rate > 0 ? Math.ceil(remaining / rate / 1000) : null;
    emitProgress({
      stage: "processing",
      completed,
      failed: failCount,
      processing: active.size,
      currentlyProcessing: [...active.values()],
      current: [...active.values()][0],
      overallPct: total === 0 ? 100 : Math.round((finished / total) * 100),
      etaSeconds,
    });
  };

  async function processIndex(index) {
    const file = included[index];
    const displayName = file.folder ? `${file.folder}/${file.name}` : file.name;
    active.set(file.id, displayName);
    updateProgress();

    try {
      const { originalAnalysis, finalAnalysis, result } = await ffmpegFileLimit.run(() =>
        processFile({ job, file, log }),
      );
      completed++;
      job.fileResults.push({ id: file.id, result });
      job.emit("file", { id: file.id, result });
      reportRows[index] = [
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
      ];
    } catch (err) {
      failCount++;
      const msg = err.message ?? String(err);
      log.error?.({ err, file: file.name }, "file failed");
      failedByIndex[index] = { name: file.name, error: msg };
      const result = { error: msg, verificationPassed: false };
      job.fileResults.push({ id: file.id, result });
      job.emit("file", { id: file.id, result });
      reportRows[index] = [
        file.sequence, file.name, file.folder ?? "",
        "", "", "", "", "", "", "",
        file.overrides?.speed ?? job.settings.speed ?? 1,
        file.overrides?.preset ?? job.settings.preset ?? "original",
        "", "", "", "", "failed", msg,
      ];
    } finally {
      active.delete(file.id);
      updateProgress();
    }
  }

  async function workerLoop() {
    while (!job.cancelled) {
      const index = nextIndex++;
      if (index >= total) return;
      await processIndex(index);
    }
  }

  const localWorkerCount = Math.min(FFMPEG_WORKERS, Math.max(1, total));
  await Promise.all(Array.from({ length: localWorkerCount }, () => workerLoop()));

  if (job.cancelled) {
    emitProgress({
      stage: "failed",
      message: "cancelled",
      processing: 0,
      currentlyProcessing: [],
    });
    return;
  }

  emitProgress({ stage: "packaging", overallPct: 100, processing: 0, currentlyProcessing: [] });
  await writeReport(job, reportRows.filter(Boolean));
  await packageZip(job, failedByIndex.filter(Boolean));
  emitProgress({ stage: "ready", overallPct: 100, etaSeconds: 0 });
  job.done = true;
  job.emit("done");
}
