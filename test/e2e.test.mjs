import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vbs-e2e-"));
process.env.WORK_ROOT = path.join(testRoot, "work");
process.env.FFMPEG_WORKERS = "4";
process.env.CORS_ORIGIN = "https://frontend.example";
process.env.LOG_LEVEL = "silent";

const [{ buildApp }, { analyzeMp3 }] = await Promise.all([
  import("../src/server.js"),
  import("../src/ffmpeg.js"),
]);

async function ffmpeg(args) {
  await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function generateInputs(directory) {
  await fs.mkdir(directory, { recursive: true });
  const definitions = [
    {
      name: "small_mono_64k.mp3",
      args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-af", "volume=0.03", "-ar", "22050", "-ac", "1", "-b:a", "64k"],
    },
    {
      name: "large_stereo_320k.mp3",
      args: ["-f", "lavfi", "-i", "anoisesrc=color=pink:duration=35:amplitude=0.12", "-ar", "48000", "-ac", "2", "-b:a", "320k"],
    },
    {
      name: "quiet_recording.mp3",
      args: ["-f", "lavfi", "-i", "sine=frequency=330:duration=9", "-af", "volume=0.0015", "-ar", "44100", "-ac", "1", "-b:a", "96k"],
    },
    {
      name: "loud_recording.mp3",
      args: ["-f", "lavfi", "-i", "sine=frequency=700:duration=9", "-af", "volume=8", "-ar", "48000", "-ac", "2", "-b:a", "256k"],
    },
    {
      name: "already_normalized.mp3",
      args: ["-f", "lavfi", "-i", "anoisesrc=color=white:duration=10:amplitude=0.1", "-af", "loudnorm=I=-16:LRA=7:TP=-1.5", "-ar", "48000", "-ac", "2", "-b:a", "192k"],
    },
    {
      name: "dynamic_recording.mp3",
      args: [
        "-f", "lavfi", "-i", "sine=frequency=260:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=520:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=780:duration=4",
        "-filter_complex",
        "[0:a]volume=0.01[a0];[1:a]volume=0.12[a1];[2:a]volume=0.75[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]",
        "-map", "[out]", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      ],
    },
    {
      name: "stereo_128k.mp3",
      args: ["-f", "lavfi", "-i", "sine=frequency=900:duration=8", "-af", "volume=0.08", "-ar", "32000", "-ac", "2", "-b:a", "128k"],
    },
  ];
  for (const definition of definitions) {
    await ffmpeg([...definition.args, path.join(directory, definition.name)]);
  }
  return definitions.map((definition, index) => ({
    id: `f${index + 1}`,
    name: definition.name,
    path: path.join(directory, definition.name),
    sequence: index + 1,
  }));
}

async function readSseUntilDone(url) {
  const response = await fetch(url, {
    headers: { Origin: "https://frontend.example" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) {
        const parsed = JSON.parse(data);
        events.push({ event, data: parsed });
        if (event === "done") return events;
      }
    }
    if (done) break;
  }
  throw new Error("SSE stream ended without a done event");
}

async function createJob(baseUrl, files, settings = {}) {
  const form = new FormData();
  form.append("payload", JSON.stringify({
    settings,
    files: files.map(({ id, name, sequence }) => ({ id, name, sequence, folder: "processed" })),
  }));
  for (const file of files) {
    const bytes = await fs.readFile(file.path);
    form.append(`file_${file.id}`, new Blob([bytes], { type: "audio/mpeg" }), file.name);
  }
  const response = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    body: form,
    headers: { Origin: "https://frontend.example" },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.jobId);
  return body.jobId;
}

let app;
let baseUrl;

await test("start server and expose healthy FFmpeg/FFprobe readiness", async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.ok(body.ffmpeg);
  assert.ok(body.ffprobe);
  assert.equal(body.targetLufs, -16);
  assert.equal(body.toleranceLu, 0.3);
  assert.equal(body.truePeakLimitDbtp, -1.5);
});

await test("CORS preflight permits the configured HTTPS frontend", async () => {
  const response = await fetch(`${baseUrl}/jobs`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://frontend.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://frontend.example");
});

await test("analyze endpoint parses a valid MP3 and rejects invalid audio", async () => {
  const inputDirectory = path.join(testRoot, "analyze-input");
  const [valid] = await generateInputs(inputDirectory);
  const validForm = new FormData();
  validForm.append("file", new Blob([await fs.readFile(valid.path)], { type: "audio/mpeg" }), valid.name);
  const validResponse = await fetch(`${baseUrl}/analyze`, { method: "POST", body: validForm });
  assert.equal(validResponse.status, 200);
  const validBody = await validResponse.json();
  assert.ok(Number.isFinite(validBody.lufs));
  assert.ok(Number.isFinite(validBody.truePeak));

  const invalidForm = new FormData();
  invalidForm.append("file", new Blob([Buffer.from("not an mp3")], { type: "audio/mpeg" }), "bad.mp3");
  const invalidResponse = await fetch(`${baseUrl}/analyze`, { method: "POST", body: invalidForm });
  assert.equal(invalidResponse.status, 422);
});

await test("full API + SSE + ZIP pipeline normalizes all input classes within strict tolerance", async () => {
  const inputDirectory = path.join(testRoot, "batch-input");
  const files = await generateInputs(inputDirectory);
  const before = new Map();
  for (const file of files) before.set(file.name, await analyzeMp3(file.path));

  const jobId = await createJob(baseUrl, files, {
    mode: "normalize_enhance",
    preset: "voice_focus",
    compressionThreshold: -24,
    compressionRatio: 2.5,
    attack: 10,
    release: 120,
    bass: 1,
    treble: 1,
    presence: 1,
    speed: 1,
    outputBitrate: 192000,
    outputSampleRate: 48000,
    outputChannels: "stereo",
    includeReports: true,
    retention: "1h",
  });

  const events = await readSseUntilDone(`${baseUrl}/jobs/${jobId}/events`);
  const done = events.at(-1);
  assert.equal(done.event, "done");
  assert.equal(done.data.success, true, JSON.stringify(done.data));
  assert.equal(events.filter((event) => event.event === "file").length, files.length);

  const statusResponse = await fetch(`${baseUrl}/jobs/${jobId}`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, "ready");
  assert.equal(status.success, true);
  assert.equal(status.progress.failed, 0);
  assert.equal(status.progress.completed, files.length);
  for (const fileResult of status.files) {
    assert.equal(fileResult.result.verificationPassed, true);
    assert.ok(Math.abs(fileResult.result.finalLufs + 16) <= 0.3);
    assert.ok(fileResult.result.finalTruePeak <= -1.5);
    assert.equal(fileResult.result.bitrate, 192000);
    assert.equal(fileResult.result.sampleRate, 48000);
    assert.equal(fileResult.result.channels, 2);
  }

  const reportResponse = await fetch(`${baseUrl}/jobs/${jobId}/report.csv`);
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.text();
  assert.match(report, /pass1_measured_threshold/);
  assert.equal(report.trim().split("\n").length, files.length + 1);
  assert.equal((report.match(/,passed,/g) ?? []).length, files.length);

  const zipResponse = await fetch(`${baseUrl}/jobs/${jobId}/download`);
  assert.equal(zipResponse.status, 200);
  const zipPath = path.join(testRoot, `${jobId}.zip`);
  await fs.writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()));
  const extractDirectory = path.join(testRoot, `${jobId}-extracted`);
  await fs.mkdir(extractDirectory, { recursive: true });
  await execFileP("unzip", ["-q", zipPath, "-d", extractDirectory]);

  const proof = [];
  for (const file of files) {
    const outputPath = path.join(extractDirectory, "processed", file.name);
    const after = await analyzeMp3(outputPath);
    assert.ok(Math.abs(after.lufs + 16) <= 0.3, `${file.name}: ${after.lufs} LUFS`);
    assert.ok(after.truePeak <= -1.5, `${file.name}: ${after.truePeak} dBTP`);
    assert.equal(after.codec, "mp3");
    assert.equal(after.sampleRate, 48000);
    assert.equal(after.channels, 2);
    assert.ok(Math.abs(after.bitrate - 192000) <= 4000, `${file.name}: bitrate ${after.bitrate}`);
    proof.push({
      file: file.name,
      beforeLufs: before.get(file.name).lufs,
      beforeTruePeak: before.get(file.name).truePeak,
      afterLufs: after.lufs,
      afterTruePeak: after.truePeak,
    });
  }
  await fs.writeFile(path.join(testRoot, "verification-proof.json"), JSON.stringify(proof, null, 2));

  const jobDirectory = path.join(process.env.WORK_ROOT, jobId);
  const entries = await fs.readdir(jobDirectory);
  assert.equal(entries.some((entry) => entry.startsWith("stage_")), false, "staging directories must be deleted");
});

await test("invalid output paths are rejected before job creation", async () => {
  const inputPath = path.join(testRoot, "bad-path.mp3");
  await ffmpeg(["-f", "lavfi", "-i", "sine=duration=3", "-b:a", "128k", inputPath]);
  const form = new FormData();
  form.append("payload", JSON.stringify({
    settings: {},
    files: [{ id: "safe", name: "bad.mp3", folder: "../../escape", sequence: 1 }],
  }));
  form.append("file_safe", new Blob([await fs.readFile(inputPath)]), "bad.mp3");
  const response = await fetch(`${baseUrl}/jobs`, { method: "POST", body: form });
  assert.equal(response.status, 400);
});

await test("corrupt audio fails the job, produces a report, and never exposes a success ZIP", async () => {
  const corruptPath = path.join(testRoot, "corrupt.mp3");
  await fs.writeFile(corruptPath, "this is not audio");
  const jobId = await createJob(baseUrl, [{ id: "bad1", name: "corrupt.mp3", path: corruptPath, sequence: 1 }]);
  const events = await readSseUntilDone(`${baseUrl}/jobs/${jobId}/events`);
  const done = events.at(-1).data;
  assert.equal(done.success, false);
  assert.equal(done.status, "failed");

  const download = await fetch(`${baseUrl}/jobs/${jobId}/download`);
  assert.equal(download.status, 409);
  const report = await fetch(`${baseUrl}/jobs/${jobId}/report.csv`);
  assert.equal(report.status, 200);
  assert.match(await report.text(), /failed/);
});

await test("close server and leave no active job subprocesses", async () => {
  await app.close();
  await fs.rm(testRoot, { recursive: true, force: true });
});
