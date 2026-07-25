# Voice Batch Studio Backend

Native FFmpeg backend for ZIP batches of MP3 narration files. It analyzes LUFS/true peak, supports presets and speed changes, applies two-pass loudness normalization, verifies outputs, preserves ZIP paths and filenames, and creates a downloadable ZIP plus CSV report.

## Railway deployment

1. Upload the `backend` folder to a GitHub repository.
2. Railway → **New Project** → **Deploy from GitHub**.
3. Set the service **Root Directory** to `/backend` if this folder is inside a larger Lovable repository.
4. Railway uses the included Dockerfile and installs native FFmpeg.
5. Generate a public domain under **Settings → Networking**.
6. Set `CORS_ORIGIN` to your Lovable URL, for example:
   `https://your-app.lovable.app,https://yourdomain.com`
7. Test `https://YOUR-RAILWAY-DOMAIN/health`.

## Environment variables

- `CORS_ORIGIN=*` during initial testing; restrict it in production.
- `MAX_UPLOAD_MB=2048`
- `JOB_RETENTION_MINUTES=60`
- `PROCESS_CONCURRENCY=2` (start with 1–2 on a small Railway instance)
- `JOB_ROOT=/tmp/voice-batch-jobs`

## API

### `POST /analyze`
Multipart form-data with one field containing a `.zip`. Returns `202 { jobId }`. Poll `GET /jobs/:id` or open SSE.

### `POST /jobs/:id/process`
JSON body example:
```json
{
  "targetLufs": -16,
  "lra": 7,
  "truePeak": -1.5,
  "speed": 1.15,
  "preset": "clear_narration",
  "bitrateKbps": 192,
  "toleranceLu": 0.5
}
```

### `POST /jobs`
Upload and immediately analyze/process. Settings can be supplied as query parameters.

### Other endpoints
- `GET /health`
- `GET /jobs/:id`
- `GET /jobs/:id/events` (SSE)
- `GET /jobs/:id/download`
- `GET /jobs/:id/report.csv`
- `POST /jobs/:id/cancel`

## Presets

`original`, `voice_focus`, `clear_narration`, `sweet_voice`, `deep_narration`, `bright_voice`, `podcast_voice`, `noisy_repair`.

## Important production notes

This starter stores jobs in memory and temporary local disk. A Railway restart loses job metadata and ephemeral files. For serious production use, add object storage (Supabase Storage/R2/S3) and Redis/Postgres-backed jobs. Start with small test ZIPs, then increase to 10, 50, and finally hundreds of MP3 files.

The backend processes files with controlled concurrency and never intentionally renames their relative ZIP paths. Malicious ZIP traversal paths are rejected.
