import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeMp3, runFfmpeg } from "../src/ffmpeg.js";
import {
  processFile,
  resolveExportSettings,
  REQUIRED_TARGET_LUFS,
  REQUIRED_TOLERANCE_LU,
  REQUIRED_TRUE_PEAK_DBTP,
  runJob,
} from "../src/pipeline.js";
import { createJob } from "../src/jobs.js";

const execFileP = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "vbs-core-"));
const inputDir = path.join(root, "in");
const outputDir = path.join(root, "out");
await fs.mkdir(inputDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });

async function ffmpeg(args) {
  await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

const definitions = [
  ["small_mono_64k.mp3", ["-f","lavfi","-i","sine=frequency=440:duration=6","-af","volume=0.03","-ar","22050","-ac","1","-b:a","64k"]],
  ["large_stereo_320k.mp3", ["-f","lavfi","-i","anoisesrc=color=pink:duration=35:amplitude=0.12","-ar","48000","-ac","2","-b:a","320k"]],
  ["quiet_recording.mp3", ["-f","lavfi","-i","sine=frequency=330:duration=9","-af","volume=0.0015","-ar","44100","-ac","1","-b:a","96k"]],
  ["loud_recording.mp3", ["-f","lavfi","-i","sine=frequency=700:duration=9","-af","volume=8","-ar","48000","-ac","2","-b:a","256k"]],
  ["already_normalized.mp3", ["-f","lavfi","-i","anoisesrc=color=white:duration=10:amplitude=0.1","-af","loudnorm=I=-16:LRA=7:TP=-1.5","-ar","48000","-ac","2","-b:a","192k"]],
  ["dynamic_recording.mp3", [
    "-f","lavfi","-i","sine=frequency=260:duration=4",
    "-f","lavfi","-i","sine=frequency=520:duration=4",
    "-f","lavfi","-i","sine=frequency=780:duration=4",
    "-filter_complex","[0:a]volume=0.01[a0];[1:a]volume=0.12[a1];[2:a]volume=0.75[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]",
    "-map","[out]","-ar","44100","-ac","2","-b:a","128k"
  ]],
  ["stereo_128k.mp3", ["-f","lavfi","-i","sine=frequency=900:duration=8","-af","volume=0.08","-ar","32000","-ac","2","-b:a","128k"]],
];

const files = [];
for (let index = 0; index < definitions.length; index += 1) {
  const [name, args] = definitions[index];
  const inputPath = path.join(inputDir, name);
  await ffmpeg([...args, inputPath]);
  files.push({ id: `f${index + 1}`, name, folder: "processed", sequence: index + 1, inputPath });
}

const settings = {
  mode: "normalize_enhance",
  preset: "voice_focus",
  compressionThreshold: -24,
  compressionRatio: 2.5,
  attack: 10,
  release: 120,
  bass: 1,
  treble: 1,
  presence: 1,
  outputBitrate: 192000,
  outputSampleRate: 48000,
  outputChannels: "stereo",
};
const job = {
  id: "core_test",
  dir: root,
  outDir: outputDir,
  settings,
  exportSettings: resolveExportSettings(settings),
  fileMap: new Map(files.map((file) => [file.id, file.inputPath])),
  abortController: new AbortController(),
};
const log = { warn() {}, error() {} };
const proof = [];

await test("strict true two-pass normalization passes all required audio classes", async () => {
  for (const file of files) {
    const before = await analyzeMp3(file.inputPath);
    const processed = await processFile({ job, file, log });
    const outputPath = path.join(outputDir, "processed", file.name);
    const after = await analyzeMp3(outputPath);

    assert.equal(processed.result.verificationPassed, true);
    assert.ok(processed.pass1Measurement);
    for (const key of ["input_i", "input_lra", "input_tp", "input_thresh", "target_offset"]) {
      assert.ok(Number.isFinite(Number(processed.pass1Measurement[key])), `${file.name}: missing ${key}`);
    }
    assert.ok(Math.abs(after.lufs - REQUIRED_TARGET_LUFS) <= REQUIRED_TOLERANCE_LU,
      `${file.name}: ${after.lufs} LUFS`);
    assert.ok(after.truePeak <= REQUIRED_TRUE_PEAK_DBTP,
      `${file.name}: ${after.truePeak} dBTP`);
    assert.equal(after.sampleRate, 48000);
    assert.equal(after.channels, 2);
    assert.ok(Math.abs(after.bitrate - 192000) <= 4000,
      `${file.name}: ${after.bitrate} bps`);

    proof.push({
      file: file.name,
      category: file.name.replace(/\.mp3$/, ""),
      before: {
        lufs: before.lufs,
        lra: before.lra,
        truePeakDbtp: before.truePeak,
        bitrate: before.bitrate,
        sampleRate: before.sampleRate,
        channels: before.channels,
      },
      pass1: processed.pass1Measurement,
      after: {
        lufs: after.lufs,
        deviationLu: Math.abs(after.lufs - REQUIRED_TARGET_LUFS),
        lra: after.lra,
        truePeakDbtp: after.truePeak,
        bitrate: after.bitrate,
        sampleRate: after.sampleRate,
        channels: after.channels,
      },
      attempts: processed.result.attempts,
      preconditioningGainDb: processed.result.preconditioningGainDb,
      passed: true,
    });
  }
});

await test("FFmpeg subprocesses abort when a job is cancelled", async () => {
  const controller = new AbortController();
  const running = runFfmpeg([
    "-hide_banner", "-nostats", "-re",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
    "-f", "null", "-",
  ], { signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, (error) => error?.name === "AbortError");
});

await test("corrupt input is rejected and is not reported as success", async () => {
  const corruptPath = path.join(inputDir, "corrupt.mp3");
  await fs.writeFile(corruptPath, "not audio");
  const corruptFile = { id: "bad", name: "corrupt.mp3", folder: "processed", sequence: 99 };
  job.fileMap.set("bad", corruptPath);
  await assert.rejects(processFile({ job, file: corruptFile, log }));
  await assert.rejects(fs.access(path.join(outputDir, "processed", "corrupt.mp3")));
});

await test("temporary stage directories are deleted", async () => {
  const entries = await fs.readdir(root);
  assert.equal(entries.some((entry) => entry.startsWith("stage_")), false);
});

await test("job lifecycle packages only fully verified output and fails closed", async () => {
  const successDir = path.join(root, "success-job");
  const successIn = path.join(successDir, "in");
  const successOut = path.join(successDir, "out");
  await fs.mkdir(successIn, { recursive: true });
  await fs.mkdir(successOut, { recursive: true });
  const successInput = path.join(successIn, "one.mp3");
  await fs.copyFile(files[0].inputPath, successInput);
  const successJob = createJob({
    id: "job_core_success",
    dir: successDir,
    inDir: successIn,
    outDir: successOut,
    settings,
    files: [{ id: "one", name: "one.mp3", folder: "batch", sequence: 1, overrides: {}, excluded: false }],
    fileMap: new Map([["one", successInput]]),
  });
  let doneEvent = null;
  successJob.once("done", (event) => { doneEvent = event; });
  await runJob(successJob, log);
  assert.equal(successJob.status, "ready");
  assert.equal(successJob.success, true);
  assert.equal(successJob.done, true);
  assert.equal(doneEvent?.success, true);
  await fs.access(path.join(successDir, "result.zip"));
  await fs.access(path.join(successDir, "report.csv"));
  const { stdout: zipListing } = await execFileP("unzip", ["-Z1", path.join(successDir, "result.zip")]);
  assert.match(zipListing, /batch\/one\.mp3/);
  assert.match(zipListing, /audio_analysis_report\.csv/);
  assert.match(zipListing, /processing_settings\.json/);

  const failedDir = path.join(root, "failed-job");
  const failedIn = path.join(failedDir, "in");
  const failedOut = path.join(failedDir, "out");
  await fs.mkdir(failedIn, { recursive: true });
  await fs.mkdir(failedOut, { recursive: true });
  const badInput = path.join(failedIn, "bad.mp3");
  await fs.writeFile(badInput, "not audio");
  const failedJob = createJob({
    id: "job_core_failed",
    dir: failedDir,
    inDir: failedIn,
    outDir: failedOut,
    settings,
    files: [{ id: "bad", name: "bad.mp3", folder: "batch", sequence: 1, overrides: {}, excluded: false }],
    fileMap: new Map([["bad", badInput]]),
  });
  await runJob(failedJob, log);
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.success, false);
  assert.equal(failedJob.done, true);
  await fs.access(path.join(failedDir, "report.csv"));
  await assert.rejects(fs.access(path.join(failedDir, "result.zip")));
});

await fs.writeFile(
  path.join(process.cwd(), "VERIFICATION_RESULTS.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    ffmpegTestEnvironment: process.platform,
    required: {
      targetLufs: REQUIRED_TARGET_LUFS,
      toleranceLu: REQUIRED_TOLERANCE_LU,
      truePeakLimitDbtp: REQUIRED_TRUE_PEAK_DBTP,
      codec: "libmp3lame",
      bitrate: 192000,
      sampleRate: 48000,
      channels: 2,
    },
    results: proof,
  }, null, 2),
);

await fs.rm(root, { recursive: true, force: true });
