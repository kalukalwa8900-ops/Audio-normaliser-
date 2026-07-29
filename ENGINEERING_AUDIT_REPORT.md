# Complete Engineering Audit Report

## Audit scope and evidence boundary

The uploaded archive contained the backend only. It did **not** contain React/Vue/Lovable frontend source, frontend environment files, or deployed frontend configuration. Therefore:

- the backend code was fully inspected and materially rewritten;
- real FFmpeg normalization and backend job-lifecycle tests were executed;
- a live HTTP/CORS/multipart/SSE integration suite was added;
- the actual frontend implementation and the deployed Railway/Lovable connection could not be inspected or truthfully certified from this archive;
- the live HTTP suite could not be executed in this sandbox because the sandbox could not resolve the npm package registry after the original partial `node_modules` installation was removed. This is an environment limitation, not a passing result. The suite remains in `test/e2e.test.mjs` for execution after `npm ci` in a networked environment.

No statement in this report treats the absent frontend or unexecuted live HTTP suite as verified.

## Executed verification

Environment:

- Node.js: 22.16.0
- FFmpeg: 7.1.3
- FFprobe: 7.1.3
- Platform: Linux

Executed commands:

```text
npm run check
node --test test/core-normalization.test.mjs
```

Executed test result:

```text
5 tests passed, 0 failed
```

The executed suite covered real encoding and remeasurement, true two-pass measurement fields, very quiet audio recovery, corrupted input rejection, FFmpeg cancellation, temporary-stage cleanup, fail-closed job status, CSV creation, and ZIP creation.

## Verified loudness results

Required output contract: -16 LUFS ±0.3 LU and true peak ≤ -1.5 dBTP.

| File / class | Before LUFS | Before TP | After LUFS | Deviation | After TP | Attempts | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| Small mono, 64 kbps, 22.05 kHz | -52.65 | -48.94 | -16.25 | 0.25 | -14.69 | 1 | Pass |
| Large stereo, 320 kbps, 35 seconds | -33.26 | -22.11 | -16.00 | 0.00 | -8.23 | 2 | Pass |
| Extremely quiet mono | Below R128 gate | -74.97 | -16.27 | 0.27 | -14.33 | 1 | Pass |
| Loud stereo | -3.55 | -3.00 | -16.25 | 0.25 | -8.36 | 1 | Pass |
| Already near normalized | -17.23 | -12.90 | -16.25 | 0.25 | -10.70 | 1 | Pass |
| Very dynamic, LRA about 18 LU | -24.54 | -24.01 | -15.99 | 0.01 | -15.10 | 2 | Pass |
| Stereo, 128 kbps, 32 kHz | -43.65 | -43.42 | -16.25 | 0.25 | -15.42 | 1 | Pass |

Observed final range: **-16.27 to -15.99 LUFS**. Maximum observed deviation: **0.27 LU**. Highest observed true peak: **-8.23 dBTP**, below the required maximum of -1.5 dBTP.

All outputs used MP3/libmp3lame, 192 kbps nominal CBR, 48 kHz, and two channels. Exact proof, including every Pass One measurement, is in `VERIFICATION_RESULTS.json`.

## Root causes and corrections

### 1. Single-pass fallback could masquerade as two-pass normalization

**Root cause:** when Pass One values were invalid, the old pipeline silently used `loudnorm=...` without measured fields.

**Correction:** non-finite or missing `input_i`, `input_lra`, `input_tp`, `input_thresh`, or `target_offset` now blocks Pass Two. Every normalization attempt performs a fresh Pass One and passes all measured values into Pass Two.

### 2. Output verification was looser than the stated contract

**Root cause:** the old default tolerance was 1.0 LU, retries were accepted at 1.5 times that tolerance, and the frontend could disable target verification.

**Correction:** -16 LUFS, ±0.3 LU, and ≤ -1.5 dBTP are backend constants. Frontend flags cannot relax or disable them.

### 3. True peak was not part of the pass/fail decision

**Root cause:** old verification checked LUFS plus approximate sample peak/RMS audibility floors but did not reject an output whose measured dBTP exceeded -1.5.

**Correction:** post-encode EBU R128 measurement must include a finite true-peak value no higher than -1.5 dBTP.

### 4. Forced gain could be called successful without matching loudness

**Root cause:** a last-resort volume boost accepted output merely because it was no longer “hard silent,” even when it was outside target LUFS.

**Correction:** the forced-gain success path was removed. A retry is another complete measured two-pass normalization attempt, and the encoded MP3 must pass the exact contract.

### 5. Very quiet but valid audio could return negative-infinity LUFS

**Root cause:** EBU R128 has an absolute gate; audio below it is unmeasurable even when it contains recoverable samples.

**Correction:** the backend performs a bounded sample-domain preflight. Recoverable below-gate audio is raised before Pass One, then processed through normal two-pass loudnorm. Digital silence remains an error. The executed test recovered an input with a -74.97 dBTP peak and produced -16.27 LUFS.

### 6. Gain-changing processing occurred after normalization

**Root cause:** an `alimiter` was appended after loudnorm, which can alter the measured final loudness.

**Correction:** presets, EQ, noise processing, speed, compression, fades, and optional limiting run before Pass One. No gain-changing filter follows loudnorm.

### 7. Intermediate channel layout did not necessarily match export layout

**Root cause:** the old staging WAV was always 48 kHz stereo, then could be converted to mono or another rate after normalization. Channel conversion after loudnorm can change loudness.

**Correction:** staging uses the same batch-wide sample rate and channel count as the final export.

### 8. Export settings were not identical across a batch

**Root cause:** “preserve” selected each source file's bitrate, sample rate, and channels, producing mixed output settings.

**Correction:** the job resolves one export profile. Defaults are 192 kbps, 48 kHz, stereo; supported global settings can change the profile, but every output in that job uses the same profile.

### 9. Metadata was discarded

**Root cause:** normalization encoded from an intermediate WAV without mapping original metadata.

**Correction:** Pass Two uses the staged audio as the audio source and the original MP3 as the metadata source.

### 10. Partial file failure still produced a “ready” ZIP

**Root cause:** the old job loop packaged successful files and set the whole job to ready even when one or more files failed.

**Correction:** any failed processing or verification makes the whole job `failed`; no `result.zip` exists. The CSV remains available. This fail-closed behavior was executed and passed in the test suite.

### 11. Job crashes could leave SSE open forever

**Root cause:** the route-level background catch changed progress to failed but did not reliably mark the job terminal or emit a terminal event.

**Correction:** jobs have explicit `status`, `success`, `error`, and `done` state. All terminal paths emit a `done` event.

### 12. SSE raw response handling was incomplete

**Root cause:** direct writes were used without explicitly hijacking the Fastify reply and without a terminal payload containing success/error state.

**Correction:** SSE now hijacks the reply, sends keepalives, removes listeners on disconnect, replays current state, and emits a terminal `done` payload.

### 13. Cancellation did not stop FFmpeg

**Root cause:** cancellation only set a Boolean checked between files; active FFmpeg processes continued running.

**Correction:** each job owns an `AbortController`. Active children receive SIGTERM and then SIGKILL if necessary; queued limiter work is removed. The executed cancellation test passed.

### 14. FFmpeg output could grow memory without a bound

**Root cause:** stdout and stderr were accumulated without a size limit.

**Correction:** captured child-process output is bounded, and FFmpeg runs with `-nostats`.

### 15. FFmpeg operations had no timeout

**Root cause:** a hung decode/filter/encode could run indefinitely.

**Correction:** a configurable process timeout is enforced through `FFMPEG_TIMEOUT_MS`, defaulting to thirty minutes per FFmpeg operation.

### 16. File IDs allowed path traversal

**Root cause:** multipart field IDs were inserted into filesystem paths without validation.

**Correction:** IDs are limited to letters, digits, underscore, and hyphen, with a maximum length.

### 17. Output filename/folder traversal was possible

**Root cause:** user-controlled `folder` and `name` values were joined directly into the output path.

**Correction:** filenames must be basename MP3 names; normalized folders cannot be absolute or escape with `..`; the final resolved path is checked against the output root.

### 18. Duplicate, empty, truncated, or unmatched uploads were not fully rejected

**Root cause:** file writes used overwrite behavior and did not consistently validate multipart truncation, zero length, duplicate IDs, missing descriptors, or extra uploads.

**Correction:** uploads use exclusive creation, are stream-pipelined, and are validated against the payload before job creation.

### 19. Temporary files could persist

**Root cause:** stage deletion occurred only after a successful file; immediate-retention failed jobs had no download-triggered cleanup; retention timing started before processing finished.

**Correction:** stage deletion is in `finally`; cleanup is scheduled after terminal state; immediate-success jobs also have a maximum fallback TTL; failed immediate jobs receive a cleanup timer.

### 20. Health could return success without FFprobe

**Root cause:** only FFmpeg was checked, failures were swallowed, and the route still returned 200.

**Correction:** health verifies both FFmpeg and FFprobe and returns 503 when either is unavailable.

### 21. Active processing remained sequential

**Root cause:** `server.js` imported the sequential pipeline while a separate “optimized” pipeline contained unsafe single-pass logic and was unused.

**Correction:** the canonical pipeline now uses a cgroup-aware configurable worker pool. The old optimized module is only a compatibility re-export.

### 22. Worker detection could use host CPUs instead of Railway limits

**Root cause:** `os.cpus()`/`availableParallelism()` can report more CPUs than a container quota.

**Correction:** worker detection reads cgroup v2 or v1 CPU quotas first and supports explicit `FFMPEG_WORKERS`/`CPU_COUNT` overrides.

### 23. A missing package was referenced by dead code

**Root cause:** `files.js` imported `unzipper`, which was not in dependencies.

**Correction:** the unused ZIP extraction code and missing dependency were removed; the file now contains only used safe upload/path/CSV helpers.

### 24. Railway dependency URLs were environment-specific

**Root cause:** the lock file resolved packages through a Lovable private cache domain that Railway may not resolve.

**Correction:** lockfile tarball URLs now point to the public npm registry while preserving integrity hashes.

### 25. Docker startup was less deterministic and ran as root

**Root cause:** the Dockerfile used `npm install`, lacked an init process, and ran the app as root.

**Correction:** it uses `npm ci`, installs FFmpeg/FFprobe/zip/tini, creates a writable work directory, and runs as the `node` user under `tini`.

### 26. Invalid environment numbers could reach startup/runtime

**Root cause:** `PORT`, upload limits, and TTL values were converted with bare `Number()`.

**Correction:** bounded positive-integer parsing supplies safe defaults.

## Files modified or added

Modified:

- `Dockerfile`
- `package.json`
- `package-lock.json`
- `railway.json`
- `README.md`
- `FIX_NOTES.md`
- `BACKEND_CONNECTION_TROUBLESHOOTING.md`
- `src/server.js`
- `src/pipeline.js`
- `src/pipeline-optimized.js`
- `src/ffmpeg.js`
- `src/concurrency.js`
- `src/jobs.js`
- `src/files.js`

Added:

- `test/core-normalization.test.mjs`
- `test/e2e.test.mjs`
- `VERIFICATION_RESULTS.json`
- `ENGINEERING_AUDIT_REPORT.md`
- `FULL_CODE_DIFF.patch`

## Principal functions modified or introduced

- FFmpeg layer: `commandVersion`, `ffmpegVersion`, `ffprobeVersion`, `ffprobeJson`, `runFfmpeg`, `parseLoudnormJson`, `measureLoudness`, `measureVolume`, `analyzeMp3`.
- Pipeline: `buildProcessingFilters`, `resolveExportSettings`, `verificationResult`, `buildSecondPassFilter`, `prepareMeasurableStage`, `renderAttempt`, `processFile`, `writeReport`, `packageZip`, `runJob`.
- Jobs/concurrency: `createJob`, `finishJob`, `detectedCpuCount`, `configuredWorkerCount`, `AsyncLimiter.run`, `createFfmpegLimiter`.
- Files: `safeUploadId`, `safeOutputPath`, `saveMultipartFile`, `csvEscape`.
- Server: `validatePayload`, `cleanupJob`, `scheduleCleanup`, `buildApp`, `startServer`, plus all health/analyze/job/status/SSE/download/report/cancel route handlers.

## Frontend audit status

**Not verified.** No frontend source was present. Consequently, the following cannot be truthfully confirmed from this upload:

- actual backend URL construction;
- frontend environment variable name/value;
- fetch wrapper behavior;
- upload FormData implementation;
- SSE client/reconnect implementation;
- response parsing and UI error display;
- download/report calls;
- retry and timeout behavior;
- mixed-content behavior in the deployed browser;
- absence of frontend unhandled promise rejections or races.

The exact backend API contract and an executable live integration test are included so the frontend can be audited once its source is supplied.

## Final confirmation

Confirmed by executed tests:

- the corrected audio core performs real measured two-pass loudnorm;
- all seven generated valid test classes passed -16 LUFS ±0.3 LU;
- all seven passed the -1.5 dBTP ceiling;
- corrupt input was rejected;
- a failed job created no success ZIP;
- successful output used consistent MP3 settings;
- active FFmpeg cancellation worked;
- stage directories were removed;
- report and ZIP lifecycle worked through the canonical job pipeline.

Not confirmed:

- real frontend-to-backend browser communication;
- live Fastify HTTP/CORS/multipart/SSE execution in this sandbox;
- Railway deployment on the user's actual service.

Those items are explicitly not labeled fixed or passing.
