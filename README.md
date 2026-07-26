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
