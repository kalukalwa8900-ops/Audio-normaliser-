# Voice Batch Studio — Backend

Node.js + Fastify backend that implements the HTTP contract in
[`../BACKEND_API.md`](../BACKEND_API.md). Uses real `ffmpeg` / `ffprobe`
for MP3 analysis and batch processing (two-pass loudnorm, voice enhancement
presets, speed control, limiter, MP3 re-encode).

## Endpoints

| Method | Path                    | Purpose                                |
|--------|-------------------------|----------------------------------------|
| GET    | `/health`               | Readiness probe (returns ffmpeg version) |
| POST   | `/analyze`              | Analyze one MP3, returns metrics       |
| POST   | `/jobs`                 | Create a batch processing job          |
| GET    | `/jobs/:id/events`      | SSE stream of progress + per-file done |
| GET    | `/jobs/:id/download`    | Final ZIP of processed files           |
| GET    | `/jobs/:id/report.csv`  | CSV analysis/verification report       |
| POST   | `/jobs/:id/cancel`      | Cancel an in-flight job                |

## Local run

Requires Node 20+ and `ffmpeg` on PATH.

```bash
cd backend
npm install
npm start           # listens on http://localhost:8080
```

Health check:
```bash
curl http://localhost:8080/health
```

Then in the Voice Batch Studio frontend, click the top-right badge, paste
`http://localhost:8080`, uncheck **Demo mode**, **Test connection**.

## Deploy to Railway

1. Push this `backend/` folder to a GitHub repo (or the whole project — set
   Railway's **Root Directory** to `backend`).
2. On Railway: **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects the `Dockerfile` (ffmpeg gets installed inside the
   image, so no extra buildpack config is needed).
4. Set environment variables (optional):
   - `CORS_ORIGIN` — comma-separated list of allowed origins.
     Default `*` (fine while testing). Set to your Lovable preview URL and
     your custom domain for production, e.g.
     `https://id-preview--xxxxx.lovable.app,https://your-domain.com`.
   - `MAX_UPLOAD_MB` — per-request cap (default `4096`).
   - `JOB_TTL_SECONDS` — how long finished jobs stay downloadable
     (default `3600`).
5. Add a **Volume** mounted at `/app/work` if you want jobs to survive
   restarts (optional; scratch data is regenerated per job anyway).
6. Once deployed, Railway gives you a public URL like
   `https://voice-batch-studio-production.up.railway.app` — paste that into
   the Voice Batch Studio badge as the backend URL.

## Deploy to any Docker host (Fly.io, Render, VPS)

```bash
docker build -t vbs-backend ./backend
docker run -p 8080:8080 -e CORS_ORIGIN='*' vbs-backend
```

## Notes on the pipeline

Each file is processed through this ffmpeg filter chain (built dynamically
from `ProcessingSettings`):

1. Optional `afftdn` noise reduction
2. Optional `highpass` / `lowpass`
3. Preset EQ chain (voice_focus, clear_narration, etc.)
4. Optional de-esser (bandstop approximation)
5. `atempo` chain for speed (auto-split when outside 0.5–2.0)
6. `acompressor`
7. Two-pass `loudnorm` (measured → applied)
8. `alimiter` for true-peak ceiling
9. Encode with `libmp3lame`

The output is verified with a second `loudnorm` pass; if the measured
LUFS is outside `verificationTolerance`, the file is re-run with dynamic
loudnorm (`linear=false`).

## Performance optimization (v1.1.0)

The processing pipeline now uses a bounded, process-wide worker queue. Each worker owns one file pipeline and starts only one FFmpeg child process at a time. This keeps multiple CPU cores busy while preventing unbounded FFmpeg process spawning when a job contains hundreds or thousands of files.

### Worker configuration

- `FFMPEG_WORKERS`: explicit maximum number of concurrently processed files/FFmpeg processes. This is the preferred override.
- `WORKER_COUNT`: backward-compatible alias for `FFMPEG_WORKERS`.
- `CPU_COUNT`: optional CPU-count override when the container runtime reports the host CPU count rather than the Railway allocation.
- `FFMPEG_LOG_CAPTURE_BYTES`: maximum captured stdout/stderr per FFmpeg process. Default: 2 MiB.

Without an override, the backend uses `2 × available CPU cores`, capped at 64. Therefore the defaults are 2 workers for 1 CPU, 4 workers for 2 CPUs, and 8 workers for 4 CPUs.

Recommended Railway settings:

```env
# 1 vCPU
FFMPEG_WORKERS=2

# 2 vCPU
FFMPEG_WORKERS=4

# 4 vCPU
FFMPEG_WORKERS=8
```

If Railway exposes more host CPUs than the service allocation, set both values explicitly, for example `CPU_COUNT=2` and `FFMPEG_WORKERS=4`.

### Optimizations included

- Controlled parallel file processing with a global queue shared by simultaneous jobs.
- The next file starts immediately when a worker finishes.
- Individual file failures are isolated and recorded without stopping the batch.
- Report rows remain in original sequence order even though files finish out of order.
- Progress now additionally reports `processing`, `currentlyProcessing`, `workerCount`, and `etaSeconds`; existing progress fields remain unchanged.
- Loudness and volume detection share one decoded audio stream using `asplit`, eliminating one full FFmpeg decode from every original and verification analysis.
- Existing two-pass loudnorm behavior is retained after enhancement, preserving output settings and quality.
- FFmpeg output capture is bounded to prevent memory growth on verbose/corrupt inputs.
- Temporary stage data is removed immediately after success or failure.
- Queueing is stream-like: the backend does not load the whole batch's audio into memory.

### Expected performance

Actual speed depends mainly on total audio duration, selected filters, MP3 encoding cost, Railway CPU throttling, and storage throughput.

| Railway allocation | Previous behavior | Optimized expected range for a 30–40 minute batch |
|---|---:|---:|
| 1 vCPU / 2 workers | Sequential | roughly 18–28 minutes |
| 2 vCPU / 4 workers | Sequential | roughly 9–15 minutes |
| 4 vCPU / 8 workers | Sequential | roughly 5–9 minutes |

These are engineering estimates, not guaranteed benchmark results. Reaching under 10 minutes generally requires at least 2–4 genuinely available vCPUs and audio/filter workloads that scale well in parallel.

### Validation

Run:

```bash
npm ci
npm run check
npm start
```

The `/health` response now also exposes detected `cpuCount` and `ffmpegWorkers` so the Railway allocation can be verified after deployment.
